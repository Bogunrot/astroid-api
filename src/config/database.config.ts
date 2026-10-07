import { registerAs } from '@nestjs/config';
import { databaseEnvSchema, validateEnv } from './env.validation';
import { MigrationCheckMode, resolveMigrationCheckMode } from '../database/migration-checker';

/**
 * Database connection configuration.
 *
 * `url` is the raw connection string. The pool sizing and timeout fields drive
 * the Prisma client setup in `PrismaService` (see `buildDatasourceUrl`):
 *   - `connectionLimit`   → Prisma `connection_limit` URL param (pool size)
 *   - `poolTimeoutMs`     → Prisma `pool_timeout` URL param (wait-for-connection)
 *   - `statementTimeoutMs`→ server-side `statement_timeout` via `options` param
 *   - `queryTimeoutMs`    → client-side race guard applied via a Prisma extension
 *
 * The `worker*` fields configure a dedicated, smaller pool for background
 * workers. It carries no server-side `statement_timeout` and a much longer
 * client-side guard so long-running worker transactions are never aborted by
 * the API-oriented timeouts.
 *
 * `migrationCheck` controls the boot-time migration status gate run by
 * `main.ts` before the HTTP server listens (see `verifyMigrationsOnStartup`);
 * `migrationsDir` overrides where the migrations folder is read from.
 */
export type DatabaseConfig = {
  url: string;
  connectionLimit: number;
  workerConnectionLimit: number;
  poolTimeoutMs: number;
  queryTimeoutMs: number;
  statementTimeoutMs: number;
  workerQueryTimeoutMs: number;
  migrationCheck: MigrationCheckMode;
  migrationsDir?: string;
  /** Wall-time threshold above which a query is logged as slow (0 = disabled). */
  slowQueryThresholdMs: number;
  connectionRetryAttempts: number;
  connectionRetryDelayMs: number;
  migrationCheckEnabled: boolean;
  migrationCheckMode: 'halt' | 'warn';
};

export const databaseConfig = registerAs('database', (): DatabaseConfig => {
  const env = validateEnv(databaseEnvSchema, process.env);
  return {
    url: env.DATABASE_URL,
    connectionLimit: env.DATABASE_CONNECTION_LIMIT,
    workerConnectionLimit: env.DATABASE_WORKER_CONNECTION_LIMIT,
    poolTimeoutMs: env.DATABASE_POOL_TIMEOUT_MS,
    queryTimeoutMs: env.DATABASE_QUERY_TIMEOUT_MS,
    statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    workerQueryTimeoutMs: env.DATABASE_WORKER_QUERY_TIMEOUT_MS,
    migrationCheck: resolveMigrationCheckMode(env.DATABASE_MIGRATION_CHECK, process.env.NODE_ENV),
    migrationsDir: env.DATABASE_MIGRATIONS_DIR,
    slowQueryThresholdMs: env.DATABASE_SLOW_QUERY_THRESHOLD_MS,
    connectionRetryAttempts: env.DATABASE_CONNECT_RETRY_ATTEMPTS,
    connectionRetryDelayMs: env.DATABASE_CONNECT_RETRY_DELAY_MS,
    migrationCheckEnabled: env.DATABASE_MIGRATION_CHECK_ENABLED,
    migrationCheckMode: env.DATABASE_MIGRATION_CHECK_MODE,
  };
});
