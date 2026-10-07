import * as fs from 'fs';
import * as path from 'path';
import { Logger, LoggerService } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Represents the status of a single migration.
 */
export interface MigrationStatus {
  /** The migration folder name (e.g. "20260830_init") */
  name: string;
  /** Whether this migration has been applied to the database */
  applied: boolean;
  /** Whether the migration finished successfully (vs. still in progress) */
  finished: boolean;
  /** Error logs if the migration failed */
  error: string | null;
}

/**
 * The result of a full migration status check.
 */
export interface MigrationCheckResult {
  /** Whether all migrations are applied and the schema is in sync */
  upToDate: boolean;
  /** All migrations found on disk */
  migrations: MigrationStatus[];
  /** Migrations that exist on disk but have not been applied */
  pending: MigrationStatus[];
  /** Migrations that failed during application */
  failed: MigrationStatus[];
  /** Human-readable summary message */
  message: string;
}

/**
 * Reads migration folder names from the prisma/migrations directory.
 * Returns an empty array if the directory doesn't exist (e.g. in CI without
 * the full repo checkout).
 */
export function getMigrationFolders(migrationsDir: string): string[] {
  try {
    if (!fs.existsSync(migrationsDir)) {
      return [];
    }
    return fs
      .readdirSync(migrationsDir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory() && dirent.name !== 'migration_lock.toml')
      .map((dirent) => dirent.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Queries the _prisma_migrations table to get the status of all applied
 * migrations. Uses $queryRawUnsafe because the table name is a Prisma
 * internal that isn't in the generated client types.
 *
 * Rows marked as rolled back (`prisma migrate resolve --rolled-back`) are
 * ignored, so a rolled-back migration is reported as pending again, matching
 * how `prisma migrate deploy` treats it.
 *
 * A missing `_prisma_migrations` table (fresh database) yields an empty map, so
 * every migration is reported as pending. Any other failure (e.g. the database
 * being unreachable) is rethrown: it must never be mistaken for "nothing
 * applied".
 */
export async function getAppliedMigrations(
  prisma: PrismaClient,
): Promise<
  Map<string, { finished: boolean; error: string | null }>
> {
  const applied = new Map<string, { finished: boolean; error: string | null }>();

  let rows: { migration_name: string; finished_at: Date | null; logs: string | null }[];
  try {
    // Query the Prisma migration history table directly.
    // The table stores each migration's name, whether it finished, and any error logs.
    rows = (await prisma.$queryRawUnsafe(
      `SELECT migration_name, finished_at, logs FROM _prisma_migrations WHERE rolled_back_at IS NULL ORDER BY started_at ASC`,
    )) as { migration_name: string; finished_at: Date | null; logs: string | null }[];
  } catch (error) {
    if (isMissingMigrationsTableError(error)) {
      // Fresh database: all migrations are considered pending.
      return applied;
    }
    throw error;
  }

  for (const row of rows) {
    applied.set(row.migration_name, {
      finished: row.finished_at !== null,
      error: row.logs,
    });
  }

  return applied;
}

/**
 * True when a raw query failed because `_prisma_migrations` does not exist
 * (Postgres `42P01 undefined_table`), i.e. no migration was ever applied.
 */
function isMissingMigrationsTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('42P01') ||
    (message.includes('_prisma_migrations') && message.includes('does not exist'))
  );
}

/**
 * Compares migration folders on disk against applied migrations in the
 * database and returns a detailed status report.
 *
 * @param prisma        - An active PrismaClient instance
 * @param migrationsDir - Absolute path to the prisma/migrations directory
 * @returns             - MigrationCheckResult with full status details
 */
export async function checkMigrationStatus(
  prisma: PrismaClient,
  migrationsDir: string,
): Promise<MigrationCheckResult> {
  const folders = getMigrationFolders(migrationsDir);
  const applied = await getAppliedMigrations(prisma);

  const migrations: MigrationStatus[] = folders.map((name) => {
    const status = applied.get(name);
    return {
      name,
      applied: status !== undefined,
      finished: status?.finished ?? false,
      error: status?.error ?? null,
    };
  });

  const pending = migrations.filter((m) => !m.applied);
  const failed = migrations.filter((m) => m.applied && !m.finished);

  const upToDate = pending.length === 0 && failed.length === 0;

  let message: string;
  if (failed.length > 0) {
    message =
      `${failed.length} migration(s) failed: ${failed.map((m) => m.name).join(', ')}. ` +
      'Database schema may be in an inconsistent state.';
  } else if (pending.length > 0) {
    message =
      `${pending.length} pending migration(s): ${pending.map((m) => m.name).join(', ')}. ` +
      'Run "prisma migrate deploy" before starting the application.';
  } else if (folders.length === 0) {
    message = 'No migration files found on disk. Schema drift check skipped.';
  } else {
    message = `All ${folders.length} migration(s) are applied and up to date.`;
  }

  return {
    upToDate,
    migrations,
    pending,
    failed,
    message,
  };
}

/**
 * Default migrations directory path relative to the project root.
 */
export function getDefaultMigrationsDir(): string {
  return path.resolve(process.cwd(), 'prisma', 'migrations');
}

/**
 * How the boot sequence reacts to the migration status check:
 *   - `strict` : abort startup when migrations are pending or failed, or when
 *                the status cannot be read (default in production)
 *   - `warn`   : log the problem with remediation steps and keep booting
 *                (default outside production)
 *   - `off`    : skip the check entirely
 */
export type MigrationCheckMode = 'strict' | 'warn' | 'off';

/**
 * Resolves the effective check mode. An explicit `DATABASE_MIGRATION_CHECK`
 * always wins; otherwise production is strict and every other environment only
 * warns, so local development is never blocked.
 */
export function resolveMigrationCheckMode(
  explicit: MigrationCheckMode | undefined,
  nodeEnv: string | undefined,
): MigrationCheckMode {
  if (explicit) {
    return explicit;
  }
  return nodeEnv === 'production' ? 'strict' : 'warn';
}

/**
 * Builds the operator-facing explanation for an out-of-sync schema, listing
 * every offending migration and the commands that resolve each situation.
 */
export function formatMigrationInstructions(result: MigrationCheckResult): string {
  const lines = ['Database schema is out of sync with this build.'];

  if (result.pending.length > 0) {
    lines.push(
      `  Pending migrations (${result.pending.length}): ${result.pending.map((m) => m.name).join(', ')}`,
    );
  }
  if (result.failed.length > 0) {
    lines.push(
      `  Failed migrations (${result.failed.length}): ${result.failed.map((m) => m.name).join(', ')}`,
    );
  }

  lines.push('To resolve:');
  if (result.pending.length > 0) {
    lines.push(
      '  - Apply the pending migrations against DATABASE_URL with "npm run prisma:deploy" ' +
        '(prisma migrate deploy), then restart the service.',
    );
  }
  if (result.failed.length > 0) {
    lines.push(
      '  - Inspect the failed migration logs in _prisma_migrations, repair the database, then run ' +
        '"npx prisma migrate resolve --rolled-back <name>" (or --applied <name>) and redeploy.',
    );
  }
  lines.push('  - To boot anyway (not recommended in production), set DATABASE_MIGRATION_CHECK=warn.');

  return lines.join('\n');
}

/**
 * Thrown at startup in `strict` mode when the database has pending or failed
 * migrations. The message carries the remediation steps, so the crash log alone
 * tells operators what to run.
 */
export class PendingMigrationsError extends Error {
  constructor(
    readonly result: MigrationCheckResult,
    message: string = formatMigrationInstructions(result),
  ) {
    super(message);
    this.name = 'PendingMigrationsError';
  }
}

/**
 * Thrown at startup in `strict` mode when the migration history could not be
 * read at all (e.g. the database is unreachable). Booting blind would defeat
 * the purpose of the check, so this is fatal too.
 */
export class MigrationStatusUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MigrationStatusUnavailableError';
  }
}

export interface MigrationStartupCheckOptions {
  /** Effective check mode, see {@link MigrationCheckMode}. */
  mode: MigrationCheckMode;
  /** Absolute path to `prisma/migrations`; defaults to {@link getDefaultMigrationsDir}. */
  migrationsDir?: string;
  /** Destination for the check's output; defaults to a Nest `Logger`. */
  logger?: Pick<LoggerService, 'log' | 'warn' | 'error'>;
}

/**
 * Boot-time gate verifying that the database schema matches the migrations
 * shipped with this build. Must run before the HTTP server starts listening so
 * a mismatched instance never accepts traffic.
 *
 * In `strict` mode it throws {@link PendingMigrationsError} or
 * {@link MigrationStatusUnavailableError}; in `warn` mode it only logs; in
 * `off` mode it does nothing. Returns the check result when one was produced.
 */
export async function verifyMigrationsOnStartup(
  prisma: PrismaClient,
  options: MigrationStartupCheckOptions,
): Promise<MigrationCheckResult | null> {
  const logger = options.logger ?? new Logger('MigrationCheck');
  const { mode } = options;

  if (mode === 'off') {
    logger.warn('Migration status check is disabled (DATABASE_MIGRATION_CHECK=off).');
    return null;
  }

  let result: MigrationCheckResult;
  try {
    result = await checkMigrationStatus(prisma, options.migrationsDir ?? getDefaultMigrationsDir());
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const message =
      `Unable to read the migration status from the database: ${reason}. ` +
      'Verify DATABASE_URL and that the database is reachable.';
    if (mode === 'strict') {
      logger.error(`${message} Aborting startup (DATABASE_MIGRATION_CHECK=strict).`);
      throw new MigrationStatusUnavailableError(message, error);
    }
    logger.warn(`${message} Continuing startup (DATABASE_MIGRATION_CHECK=warn).`);
    return null;
  }

  if (result.upToDate) {
    if (result.migrations.length === 0) {
      // Nothing on disk to compare against, typically a build that does not
      // ship `prisma/migrations`. Surface it rather than silently passing.
      logger.warn(
        `${result.message} Set DATABASE_MIGRATIONS_DIR to the migrations folder to enable the check.`,
      );
    } else {
      logger.log(result.message);
    }
    return result;
  }

  const instructions = formatMigrationInstructions(result);
  if (mode === 'strict') {
    logger.error(`${instructions}\nAborting startup (DATABASE_MIGRATION_CHECK=strict).`);
    throw new PendingMigrationsError(result, instructions);
  }

  logger.error(`${instructions}\nContinuing startup (DATABASE_MIGRATION_CHECK=warn).`);
  return result;
}
