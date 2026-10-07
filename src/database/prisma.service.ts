import {
  INestApplication,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { DatabaseConfig } from '../config/database.config';
import { ShutdownCoordinator } from '../common/shutdown/shutdown-coordinator.service';
import { buildDatasourceUrl } from './datasource-url';
import { createQueryMetricsExtension } from './query-metrics.extension';
import { createQueryTimeoutExtension } from './query-timeout.extension';
import {
  checkMigrationStatus,
  getDefaultMigrationsDir,
  MigrationCheckMode,
  MigrationCheckResult,
  verifyMigrationsOnStartup,
} from './migration-checker';

/**
 * The single Prisma client for the application. Manages connection lifecycle
 * and exposes graceful shutdown hooks. All repositories depend on this service.
 *
 * Connection-pool optimization and query-timeout guards (issue #76):
 *  - The datasource URL is built from `DATABASE_*` env vars with
 *    `connection_limit`, `pool_timeout` and a server-side
 *    `options=-c statement_timeout=...`, so runaway queries are aborted by
 *    Postgres and the pooled connection is actually released.
 *  - A Prisma client extension wraps every operation with a client-side race
 *    that fails fast with a structured `DatabaseTimeoutError` once a query
 *    exceeds `DATABASE_QUERY_TIMEOUT_MS`, and converts pool exhaustion
 *    (Prisma P2024) into a structured `ConnectionPoolExhaustedError`.
 *  - `workerClient` is a dedicated, smaller pool with extended timeouts and NO
 *    server-side `statement_timeout`, so long-running background worker
 *    transactions are never killed by the API-oriented guards.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly connectionRetryAttempts: number;
  private readonly connectionRetryDelayMs: number;

  /**
   * Dedicated client for background workers. It uses its own (smaller) pool
   * sized by `DATABASE_WORKER_CONNECTION_LIMIT`, carries no server-side
   * `statement_timeout`, and enforces the much longer
   * `DATABASE_WORKER_QUERY_TIMEOUT_MS` guard. Workers that run long
   * transactions (rollups, outbox drains, webhook persistence) should use this
   * client so their work is never aborted by API request timeouts.
   */
  readonly workerClient: PrismaClient;

  /** True when the {@link ShutdownCoordinator} owns the disconnect timing. */
  private readonly coordinatedShutdown: boolean;
  private readonly migrationCheck: MigrationCheckMode;
  private readonly migrationsDir?: string;

  constructor(configService: ConfigService, @Optional() shutdown?: ShutdownCoordinator) {
    const database = configService.getOrThrow<DatabaseConfig>('database');

    const url = buildDatasourceUrl(database.url, {
      connectionLimit: database.connectionLimit,
      poolTimeoutMs: database.poolTimeoutMs,
      statementTimeoutMs: database.statementTimeoutMs,
    });

    super({
      datasources: { db: { url } },
      log: [
        { level: 'warn', emit: 'event' },
        { level: 'error', emit: 'event' },
      ],
    });
    this.connectionRetryAttempts = database.connectionRetryAttempts;
    this.connectionRetryDelayMs = database.connectionRetryDelayMs;

    // Inject the metrics + timeout-guard extensions into this (API) client.
    // `$extends` returns a new client; copying its delegates onto `this` keeps
    // the PrismaService identity every repository already depends on.
    Object.assign(
      this,
      this.$extends(createQueryMetricsExtension({ slowQueryThresholdMs: database.slowQueryThresholdMs }))
          .$extends(
            createQueryTimeoutExtension({
              queryTimeoutMs: database.queryTimeoutMs,
              poolTimeoutMs: database.poolTimeoutMs,
            }),
          ) as unknown as PrismaClient,
    );

    // Dedicated worker pool: smaller, extended timeout, no statement_timeout.
    const workerUrl = buildDatasourceUrl(database.url, {
      connectionLimit: database.workerConnectionLimit,
      poolTimeoutMs: database.poolTimeoutMs,
      statementTimeoutMs: 0,
    });
    this.workerClient = new PrismaClient({
      datasources: { db: { url: workerUrl } },
      log: [
        { level: 'warn', emit: 'event' },
        { level: 'error', emit: 'event' },
      ],
    }).$extends(
      createQueryTimeoutExtension({
        queryTimeoutMs: database.workerQueryTimeoutMs,
        poolTimeoutMs: database.poolTimeoutMs,
      }),
    ) as unknown as PrismaClient;

    // The database is the last resource released on shutdown, after workers,
    // queues and Redis, so nothing can still be issuing queries.
    this.coordinatedShutdown = shutdown !== undefined;
    shutdown?.register({ name: 'prisma', phase: 'database', close: () => this.disconnectAll() });
    this.migrationCheck = database.migrationCheck;
    this.migrationsDir = database.migrationsDir;
  }

  async onModuleInit(): Promise<void> {
    await this.connectWithRetry('API', () => this.$connect());
    await this.connectWithRetry('worker', () => this.workerClient.$connect());
    await this.validateMigrations();
    this.logger.log('Prisma connected to the database and migrations are up to date');
  }

  private async connectWithRetry(pool: string, connect: () => Promise<void>): Promise<void> {
    for (let attempt = 1; attempt <= this.connectionRetryAttempts; attempt += 1) {
      try {
        await connect();
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === this.connectionRetryAttempts) {
          this.logger.error(
            `Prisma ${pool} database connection failed after ${attempt} attempt(s): ${message}`,
          );
          throw error;
        }

        const delayMs = Math.min(this.connectionRetryDelayMs * 2 ** (attempt - 1), 30_000);
        this.logger.warn(
          `Prisma ${pool} database connection attempt ${attempt}/${this.connectionRetryAttempts} failed: ${message}. Retrying in ${delayMs}ms.`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  /**
   * Configurable boot-time migration gate. Called by `main.ts` before the
   * HTTP server starts listening. In `strict` mode (the production default,
   * see `DATABASE_MIGRATION_CHECK`) pending/failed migrations, or a database
   * whose migration history cannot be read, throw and abort startup; in
   * `warn` mode they are logged with remediation steps; `off` skips the check
   * entirely.
   */
  async verifyMigrations(): Promise<MigrationCheckResult | null> {
    return verifyMigrationsOnStartup(this, {
      mode: this.migrationCheck,
      migrationsDir: this.migrationsDir,
      logger: this.logger,
    });
  }

  /**
   * Unconditional migration check run by `onModuleInit` right after
   * connecting: a pending or failed migration always throws here, so a
   * mismatched instance can never finish booting, regardless of
   * `DATABASE_MIGRATION_CHECK`.
   */
  async validateMigrations(): Promise<MigrationCheckResult> {
    const migrationsDir = getDefaultMigrationsDir();
    const result = await checkMigrationStatus(this, migrationsDir);

    if (!result.upToDate) {
      this.logger.error(
        `Migration status check failed: ${result.message}`,
        JSON.stringify({
          pending: result.pending.map((m) => m.name),
          failed: result.failed.map((m) => m.name),
        }),
      );
    } else if (result.migrations.length > 0) {
      this.logger.log(result.message);
    }

    if (!result.upToDate) {
      throw new Error(`Database migrations are not up to date: ${result.message}`);
    }

    return result;
  }

  async onModuleDestroy(): Promise<void> {
    // Under the coordinator, disconnecting here would run before workers and
    // queues have finished; it disconnects in the `database` phase instead.
    if (!this.coordinatedShutdown) {
      await this.disconnectAll();
    }
  }

  /** Closes both connection pools. Safe to call more than once. */
  async disconnectAll(): Promise<void> {
    await this.$disconnect();
    await this.workerClient.$disconnect();
  }

  /**
   * Reads live connection counts for this database from Postgres'
   * `pg_stat_activity`. Prisma's Rust query engine doesn't expose pool
   * internals (active/idle/waiting) through the Node client, so this is the
   * only accurate source for those numbers — used by MetricsService to
   * publish `db_pool_connections`.
   */
  async getPoolStats(): Promise<{ active: number; idle: number; waiting: number }> {
    try {
      const rows = await this.$queryRawUnsafe<
        { state: string | null; wait_event_type: string | null; count: bigint }[]
      >(
        `SELECT state, wait_event_type, count(*) AS count
         FROM pg_stat_activity
         WHERE datname = current_database()
         GROUP BY state, wait_event_type`,
      );

      let active = 0;
      let idle = 0;
      let waiting = 0;

      for (const row of rows) {
        const count = Number(row.count);
        if (row.wait_event_type === 'Lock') {
          waiting += count;
        } else if (row.state === 'active') {
          active += count;
        } else if (row.state?.startsWith('idle')) {
          idle += count;
        }
      }

      return { active, idle, waiting };
    } catch (error) {
      this.logger.warn(`Failed to read pool stats from pg_stat_activity: ${(error as Error).message}`);
      return { active: 0, idle: 0, waiting: 0 };
    }
  }

  /** Registers a Nest shutdown hook so the process closes the pool cleanly. */
  async enableShutdownHooks(app: INestApplication): Promise<void> {
    process.on('beforeExit', () => {
      void app.close();
    });
  }
}
