import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import {
  getMigrationFolders,
  getAppliedMigrations,
  checkMigrationStatus,
  getDefaultMigrationsDir,
  formatMigrationInstructions,
  MigrationStatusUnavailableError,
  PendingMigrationsError,
  resolveMigrationCheckMode,
  verifyMigrationsOnStartup,
} from './migration-checker';

// Mock fs module
vi.mock('fs');

const mockFs = vi.mocked(fs);

describe('MigrationChecker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getMigrationFolders', () => {
    it('should return sorted migration folder names', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue([
        { name: '20260830_02_init', isDirectory: () => true, isFile: () => false } as fs.Dirent,
        { name: '20260830_01_create_users', isDirectory: () => true, isFile: () => false } as fs.Dirent,
        { name: 'migration_lock.toml', isDirectory: () => false, isFile: () => true } as fs.Dirent,
      ]);

      const result = getMigrationFolders('/fake/migrations');

      expect(result).toEqual(['20260830_01_create_users', '20260830_02_init']);
      expect(mockFs.existsSync).toHaveBeenCalledWith('/fake/migrations');
    });

    it('should return empty array when directory does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = getMigrationFolders('/nonexistent/path');

      expect(result).toEqual([]);
    });

    it('should return empty array when directory is empty', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue([]);

      const result = getMigrationFolders('/empty/migrations');

      expect(result).toEqual([]);
    });

    it('should filter out non-directory entries', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue([
        { name: '20260830_01_init', isDirectory: () => true, isFile: () => false } as fs.Dirent,
        { name: 'some_file.txt', isDirectory: () => false, isFile: () => true } as fs.Dirent,
      ]);

      const result = getMigrationFolders('/fake/migrations');

      expect(result).toEqual(['20260830_01_init']);
    });

    it('should handle fs errors gracefully', () => {
      mockFs.existsSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const result = getMigrationFolders('/protected/path');

      expect(result).toEqual([]);
    });
  });

  describe('getAppliedMigrations', () => {
    it('should return applied migrations from the database', async () => {
      const mockPrisma = {
        $queryRawUnsafe: vi.fn().mockResolvedValue([
          {
            migration_name: '20260830_01_init',
            finished_at: new Date('2026-08-30T10:00:00Z'),
            logs: null,
          },
          {
            migration_name: '20260830_02_add_users',
            finished_at: new Date('2026-08-30T10:05:00Z'),
            logs: null,
          },
        ]),
      };

      const result = await getAppliedMigrations(mockPrisma as unknown as import('@prisma/client').PrismaClient);

      expect(result.size).toBe(2);
      expect(result.get('20260830_01_init')).toEqual({
        finished: true,
        error: null,
      });
      expect(result.get('20260830_02_add_users')).toEqual({
        finished: true,
        error: null,
      });
    });

    it('should detect failed migrations (finished_at is null)', async () => {
      const mockPrisma = {
        $queryRawUnsafe: vi.fn().mockResolvedValue([
          {
            migration_name: '20260830_01_init',
            finished_at: new Date('2026-08-30T10:00:00Z'),
            logs: null,
          },
          {
            migration_name: '20260830_02_add_users',
            finished_at: null,
            logs: 'ERROR: relation "users" already exists',
          },
        ]),
      };

      const result = await getAppliedMigrations(mockPrisma as unknown as import('@prisma/client').PrismaClient);

      expect(result.size).toBe(2);
      expect(result.get('20260830_01_init')?.finished).toBe(true);
      expect(result.get('20260830_02_add_users')?.finished).toBe(false);
      expect(result.get('20260830_02_add_users')?.error).toBe(
        'ERROR: relation "users" already exists',
      );
    });

    it('should return empty map when table does not exist', async () => {
      const mockPrisma = {
        $queryRawUnsafe: vi.fn().mockRejectedValue(
          new Error('relation "_prisma_migrations" does not exist'),
        ),
      };

      const result = await getAppliedMigrations(mockPrisma as unknown as import('@prisma/client').PrismaClient);

      expect(result.size).toBe(0);
    });

    it('should treat a Postgres 42P01 (undefined_table) error as a fresh database', async () => {
      const mockPrisma = {
        $queryRawUnsafe: vi.fn().mockRejectedValue(
          new Error('Raw query failed. Code: `42P01`. Message: `relation does not exist`'),
        ),
      };

      const result = await getAppliedMigrations(mockPrisma as unknown as import('@prisma/client').PrismaClient);

      expect(result.size).toBe(0);
    });

    it('should rethrow errors other than a missing migrations table', async () => {
      const mockPrisma = {
        $queryRawUnsafe: vi.fn().mockRejectedValue(
          new Error("Can't reach database server at `localhost:5432`"),
        ),
      };

      await expect(
        getAppliedMigrations(mockPrisma as unknown as import('@prisma/client').PrismaClient),
      ).rejects.toThrow("Can't reach database server");
    });

    it('should exclude rolled-back migrations from the query', async () => {
      const mockPrisma = {
        $queryRawUnsafe: vi.fn().mockResolvedValue([]),
      };

      await getAppliedMigrations(mockPrisma as unknown as import('@prisma/client').PrismaClient);

      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('WHERE rolled_back_at IS NULL'),
      );
    });

    it('should return empty map when no migrations have been applied', async () => {
      const mockPrisma = {
        $queryRawUnsafe: vi.fn().mockResolvedValue([]),
      };

      const result = await getAppliedMigrations(mockPrisma as unknown as import('@prisma/client').PrismaClient);

      expect(result.size).toBe(0);
    });
  });

  describe('checkMigrationStatus', () => {
    it('should report up-to-date when all migrations are applied', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue([
        { name: '20260830_01_init', isDirectory: () => true, isFile: () => false } as fs.Dirent,
        { name: '20260830_02_add_users', isDirectory: () => true, isFile: () => false } as fs.Dirent,
      ]);

      const mockPrisma = {
        $queryRawUnsafe: vi.fn().mockResolvedValue([
          {
            migration_name: '20260830_01_init',
            finished_at: new Date('2026-08-30T10:00:00Z'),
            logs: null,
          },
          {
            migration_name: '20260830_02_add_users',
            finished_at: new Date('2026-08-30T10:05:00Z'),
            logs: null,
          },
        ]),
      };

      const result = await checkMigrationStatus(mockPrisma as unknown as import('@prisma/client').PrismaClient, '/fake/migrations');

      expect(result.upToDate).toBe(true);
      expect(result.pending).toEqual([]);
      expect(result.failed).toEqual([]);
      expect(result.message).toContain('All 2 migration(s) are applied and up to date');
    });

    it('should detect pending migrations', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue([
        { name: '20260830_01_init', isDirectory: () => true, isFile: () => false } as fs.Dirent,
        { name: '20260830_02_add_users', isDirectory: () => true, isFile: () => false } as fs.Dirent,
      ]);

      const mockPrisma = {
        $queryRawUnsafe: vi.fn().mockResolvedValue([
          {
            migration_name: '20260830_01_init',
            finished_at: new Date('2026-08-30T10:00:00Z'),
            logs: null,
          },
        ]),
      };

      const result = await checkMigrationStatus(mockPrisma as unknown as import('@prisma/client').PrismaClient, '/fake/migrations');

      expect(result.upToDate).toBe(false);
      expect(result.pending).toHaveLength(1);
      expect(result.pending[0].name).toBe('20260830_02_add_users');
      expect(result.pending[0].applied).toBe(false);
      expect(result.message).toContain('1 pending migration(s)');
    });

    it('should detect failed migrations', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue([
        { name: '20260830_01_init', isDirectory: () => true, isFile: () => false } as fs.Dirent,
        { name: '20260830_02_add_users', isDirectory: () => true, isFile: () => false } as fs.Dirent,
      ]);

      const mockPrisma = {
        $queryRawUnsafe: vi.fn().mockResolvedValue([
          {
            migration_name: '20260830_01_init',
            finished_at: new Date('2026-08-30T10:00:00Z'),
            logs: null,
          },
          {
            migration_name: '20260830_02_add_users',
            finished_at: null,
            logs: 'ERROR: column "email" already exists',
          },
        ]),
      };

      const result = await checkMigrationStatus(mockPrisma as unknown as import('@prisma/client').PrismaClient, '/fake/migrations');

      expect(result.upToDate).toBe(false);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].name).toBe('20260830_02_add_users');
      expect(result.failed[0].error).toBe('ERROR: column "email" already exists');
      expect(result.message).toContain('1 migration(s) failed');
    });

    it('should handle empty migrations directory', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue([]);

      const mockPrisma = {
        $queryRawUnsafe: vi.fn().mockResolvedValue([]),
      };

      const result = await checkMigrationStatus(mockPrisma as unknown as import('@prisma/client').PrismaClient, '/fake/migrations');

      expect(result.upToDate).toBe(true);
      expect(result.pending).toEqual([]);
      expect(result.message).toContain('No migration files found');
    });

    it('should handle missing migrations directory', async () => {
      mockFs.existsSync.mockReturnValue(false);

      const mockPrisma = {
        $queryRawUnsafe: vi.fn().mockResolvedValue([]),
      };

      const result = await checkMigrationStatus(mockPrisma as unknown as import('@prisma/client').PrismaClient, '/nonexistent/migrations');

      expect(result.upToDate).toBe(true);
      expect(result.pending).toEqual([]);
      expect(result.message).toContain('No migration files found');
    });

    it('should prioritize failed migrations over pending in message', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue([
        { name: '20260830_01_init', isDirectory: () => true, isFile: () => false } as fs.Dirent,
        { name: '20260830_02_add_users', isDirectory: () => true, isFile: () => false } as fs.Dirent,
        { name: '20260830_03_add_roles', isDirectory: () => true, isFile: () => false } as fs.Dirent,
      ]);

      const mockPrisma = {
        $queryRawUnsafe: vi.fn().mockResolvedValue([
          {
            migration_name: '20260830_01_init',
            finished_at: new Date('2026-08-30T10:00:00Z'),
            logs: null,
          },
          {
            migration_name: '20260830_02_add_users',
            finished_at: null,
            logs: 'ERROR: something went wrong',
          },
        ]),
      };

      const result = await checkMigrationStatus(mockPrisma as unknown as import('@prisma/client').PrismaClient, '/fake/migrations');

      expect(result.upToDate).toBe(false);
      expect(result.failed).toHaveLength(1);
      expect(result.pending).toHaveLength(1);
      // Failed message takes priority in the summary
      expect(result.message).toContain('1 migration(s) failed');
      expect(result.message).toContain('20260830_02_add_users');
    });
  });

  describe('getDefaultMigrationsDir', () => {
    it('should return a path ending with prisma/migrations', () => {
      const dir = getDefaultMigrationsDir();
      expect(dir).toMatch(/prisma[\\/]migrations$/);
    });
  });

  describe('resolveMigrationCheckMode', () => {
    it('should default to strict in production', () => {
      expect(resolveMigrationCheckMode(undefined, 'production')).toBe('strict');
    });

    it('should default to warn outside production', () => {
      expect(resolveMigrationCheckMode(undefined, 'development')).toBe('warn');
      expect(resolveMigrationCheckMode(undefined, 'test')).toBe('warn');
      expect(resolveMigrationCheckMode(undefined, undefined)).toBe('warn');
    });

    it('should let an explicit mode override the environment default', () => {
      expect(resolveMigrationCheckMode('warn', 'production')).toBe('warn');
      expect(resolveMigrationCheckMode('strict', 'development')).toBe('strict');
      expect(resolveMigrationCheckMode('off', 'production')).toBe('off');
    });
  });

  describe('formatMigrationInstructions', () => {
    const pending = { name: '20260901_add_x', applied: false, finished: false, error: null };
    const failed = { name: '20260830_add_y', applied: true, finished: false, error: 'boom' };

    it('should list pending migrations with the deploy command', () => {
      const text = formatMigrationInstructions({
        upToDate: false,
        migrations: [pending],
        pending: [pending],
        failed: [],
        message: '',
      });

      expect(text).toContain('Pending migrations (1): 20260901_add_x');
      expect(text).toContain('npm run prisma:deploy');
      expect(text).not.toContain('migrate resolve');
      expect(text).toContain('DATABASE_MIGRATION_CHECK=warn');
    });

    it('should list failed migrations with the resolve command', () => {
      const text = formatMigrationInstructions({
        upToDate: false,
        migrations: [failed],
        pending: [],
        failed: [failed],
        message: '',
      });

      expect(text).toContain('Failed migrations (1): 20260830_add_y');
      expect(text).toContain('prisma migrate resolve --rolled-back <name>');
      expect(text).not.toContain('prisma:deploy');
    });
  });

  describe('verifyMigrationsOnStartup', () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    type Client = import('@prisma/client').PrismaClient;

    function givenMigrationsOnDisk(names: string[]): void {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue(
        names.map(
          (name) => ({ name, isDirectory: () => true, isFile: () => false }) as fs.Dirent,
        ),
      );
    }

    function prismaWithApplied(names: string[]): Client {
      return {
        $queryRawUnsafe: vi.fn().mockResolvedValue(
          names.map((migration_name) => ({
            migration_name,
            finished_at: new Date('2026-08-30T10:00:00Z'),
            logs: null,
          })),
        ),
      } as unknown as Client;
    }

    function unreachablePrisma(): Client {
      return {
        $queryRawUnsafe: vi.fn().mockRejectedValue(new Error('Cannot reach database server')),
      } as unknown as Client;
    }

    it('should proceed when every migration is applied', async () => {
      givenMigrationsOnDisk(['20260830_01_init']);

      const result = await verifyMigrationsOnStartup(prismaWithApplied(['20260830_01_init']), {
        mode: 'strict',
        migrationsDir: '/fake/migrations',
        logger,
      });

      expect(result?.upToDate).toBe(true);
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('up to date'));
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('should abort with PendingMigrationsError in strict mode when migrations are pending', async () => {
      givenMigrationsOnDisk(['20260830_01_init', '20260830_02_add_users']);

      const run = verifyMigrationsOnStartup(prismaWithApplied(['20260830_01_init']), {
        mode: 'strict',
        migrationsDir: '/fake/migrations',
        logger,
      });

      await expect(run).rejects.toBeInstanceOf(PendingMigrationsError);
      await expect(run).rejects.toThrow('20260830_02_add_users');
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Aborting startup'));
    });

    it('should expose the check result on PendingMigrationsError', async () => {
      givenMigrationsOnDisk(['20260830_01_init']);

      const error = await verifyMigrationsOnStartup(prismaWithApplied([]), {
        mode: 'strict',
        migrationsDir: '/fake/migrations',
        logger,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PendingMigrationsError);
      expect((error as PendingMigrationsError).result.pending.map((m) => m.name)).toEqual([
        '20260830_01_init',
      ]);
    });

    it('should log and continue in warn mode when migrations are pending', async () => {
      givenMigrationsOnDisk(['20260830_01_init', '20260830_02_add_users']);

      const result = await verifyMigrationsOnStartup(prismaWithApplied(['20260830_01_init']), {
        mode: 'warn',
        migrationsDir: '/fake/migrations',
        logger,
      });

      expect(result?.upToDate).toBe(false);
      expect(result?.pending.map((m) => m.name)).toEqual(['20260830_02_add_users']);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Continuing startup'));
    });

    it('should abort with MigrationStatusUnavailableError in strict mode when the DB is unreachable', async () => {
      givenMigrationsOnDisk(['20260830_01_init']);

      await expect(
        verifyMigrationsOnStartup(unreachablePrisma(), {
          mode: 'strict',
          migrationsDir: '/fake/migrations',
          logger,
        }),
      ).rejects.toBeInstanceOf(MigrationStatusUnavailableError);
    });

    it('should warn and continue in warn mode when the DB is unreachable', async () => {
      givenMigrationsOnDisk(['20260830_01_init']);

      const result = await verifyMigrationsOnStartup(unreachablePrisma(), {
        mode: 'warn',
        migrationsDir: '/fake/migrations',
        logger,
      });

      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Unable to read the migration status'),
      );
    });

    it('should skip the check entirely in off mode', async () => {
      const prisma = prismaWithApplied([]);

      const result = await verifyMigrationsOnStartup(prisma, { mode: 'off', logger });

      expect(result).toBeNull();
      expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('disabled'));
    });

    it('should warn rather than abort when no migrations ship with the build', async () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = await verifyMigrationsOnStartup(prismaWithApplied([]), {
        mode: 'strict',
        migrationsDir: '/missing/migrations',
        logger,
      });

      expect(result?.upToDate).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('DATABASE_MIGRATIONS_DIR'));
    });
  });
});
