import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { DatabaseConfig } from '../config/database.config';
import {
  MigrationCheckMode,
  MigrationStatusUnavailableError,
  PendingMigrationsError,
} from './migration-checker';

/**
 * Integration coverage for the boot-time migration gate: a real
 * `PrismaService` (real generated client, never connected) reads a real
 * migrations folder on disk, while only the `_prisma_migrations` query is
 * simulated. This mirrors what `main.ts` does before `app.listen()`.
 */

const MIGRATIONS = [
  '0_init',
  '20260830174000_sync_schema',
  '20260901080000_add_cleanup_job_logs',
];

let migrationsDir: string;

beforeAll(() => {
  migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astroid-migrations-'));
  for (const name of MIGRATIONS) {
    fs.mkdirSync(path.join(migrationsDir, name));
    fs.writeFileSync(path.join(migrationsDir, name, 'migration.sql'), 'SELECT 1;');
  }
  fs.writeFileSync(path.join(migrationsDir, 'migration_lock.toml'), 'provider = "postgresql"');
});

afterAll(() => {
  fs.rmSync(migrationsDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

type MigrationRow = { migration_name: string; finished_at: Date | null; logs: string | null };

function buildService(mode: MigrationCheckMode, history: MigrationRow[] | Error): PrismaService {
  const database: DatabaseConfig = {
    url: 'postgresql://user:pass@localhost:5432/astroid?schema=public',
    connectionLimit: 1,
    workerConnectionLimit: 1,
    poolTimeoutMs: 1000,
    queryTimeoutMs: 1000,
    statementTimeoutMs: 1000,
    workerQueryTimeoutMs: 1000,
    slowQueryThresholdMs: 1000,
    connectionRetryAttempts: 3,
    connectionRetryDelayMs: 100,
    migrationCheck: mode,
    migrationsDir,
    migrationCheckEnabled: true,
    migrationCheckMode: 'halt',
  };
  const config = { getOrThrow: vi.fn().mockReturnValue(database) } as unknown as ConfigService;
  const service = new PrismaService(config);

  // Simulate the `_prisma_migrations` table (or an unreachable database).
  Object.assign(service, {
    $queryRawUnsafe: vi.fn(async () => {
      if (history instanceof Error) throw history;
      return history;
    }),
  });
  return service;
}

function applied(...names: string[]): MigrationRow[] {
  return names.map((migration_name) => ({
    migration_name,
    finished_at: new Date('2026-09-01T08:00:00Z'),
    logs: null,
  }));
}

describe('PrismaService.verifyMigrations (startup gate)', () => {
  it('lets startup proceed when the database has every shipped migration', async () => {
    const service = buildService('strict', applied(...MIGRATIONS));

    const result = await service.verifyMigrations();

    expect(result?.upToDate).toBe(true);
    expect(result?.migrations.map((m) => m.name)).toEqual(MIGRATIONS);
  });

  it('aborts startup in strict mode when the newest migration is not applied', async () => {
    const service = buildService('strict', applied('0_init', '20260830174000_sync_schema'));

    const error = await service.verifyMigrations().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PendingMigrationsError);
    expect((error as Error).message).toContain('20260901080000_add_cleanup_job_logs');
    expect((error as Error).message).toContain('npm run prisma:deploy');
  });

  it('aborts startup in strict mode when a migration failed mid-way', async () => {
    const service = buildService('strict', [
      ...applied('0_init', '20260830174000_sync_schema'),
      {
        migration_name: '20260901080000_add_cleanup_job_logs',
        finished_at: null,
        logs: 'ERROR: relation "cleanup_job_logs" already exists',
      },
    ]);

    const error = await service.verifyMigrations().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PendingMigrationsError);
    expect((error as PendingMigrationsError).result.failed.map((m) => m.name)).toEqual([
      '20260901080000_add_cleanup_job_logs',
    ]);
    expect((error as Error).message).toContain('prisma migrate resolve');
  });

  it('aborts startup in strict mode against a fresh, never-migrated database', async () => {
    const service = buildService(
      'strict',
      new Error('relation "_prisma_migrations" does not exist'),
    );

    const error = await service.verifyMigrations().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PendingMigrationsError);
    expect((error as PendingMigrationsError).result.pending).toHaveLength(MIGRATIONS.length);
  });

  it('aborts startup in strict mode when the database cannot be reached', async () => {
    const service = buildService('strict', new Error('Cannot reach database server'));

    await expect(service.verifyMigrations()).rejects.toBeInstanceOf(
      MigrationStatusUnavailableError,
    );
  });

  it('only logs in warn mode so development startup is not blocked', async () => {
    const service = buildService('warn', applied('0_init'));

    const result = await service.verifyMigrations();

    expect(result?.upToDate).toBe(false);
    expect(result?.pending).toHaveLength(2);
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining('Continuing startup'),
    );
  });

  it('never queries the database in off mode', async () => {
    const service = buildService('off', applied());

    await expect(service.verifyMigrations()).resolves.toBeNull();
    expect(service.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
