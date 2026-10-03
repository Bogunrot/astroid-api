import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import {
  getMigrationFolders,
  getAppliedMigrations,
  checkMigrationStatus,
  getDefaultMigrationsDir,
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
});
