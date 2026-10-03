import * as fs from 'fs';
import * as path from 'path';
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
 */
export async function getAppliedMigrations(
  prisma: PrismaClient,
): Promise<
  Map<string, { finished: boolean; error: string | null }>
> {
  const applied = new Map<string, { finished: boolean; error: string | null }>();

  try {
    // Query the Prisma migration history table directly.
    // The table stores each migration's name, whether it finished, and any error logs.
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT migration_name, finished_at, logs FROM _prisma_migrations ORDER BY started_at ASC`,
    )) as { migration_name: string; finished_at: Date | null; logs: string | null }[];

    for (const row of rows) {
      applied.set(row.migration_name, {
        finished: row.finished_at !== null,
        error: row.logs,
      });
    }
  } catch {
    // If the _prisma_migrations table doesn't exist yet (fresh database),
    // return an empty map — all migrations are considered pending.
  }

  return applied;
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
