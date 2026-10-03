import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { PrismaHealthIndicator } from './prisma.health';

/** Minimal stand-in for PrismaService exposing only `$queryRaw`. */
function buildPrisma() {
  const queryRaw = vi.fn();
  return { queryRaw, prisma: { $queryRaw: queryRaw } as never };
}

describe('PrismaHealthIndicator', () => {
  let queryRaw: ReturnType<typeof vi.fn>;
  let prisma: ReturnType<typeof buildPrisma>['prisma'];
  let indicator: PrismaHealthIndicator;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const built = buildPrisma();
    queryRaw = built.queryRaw;
    prisma = built.prisma;
    indicator = new PrismaHealthIndicator(prisma);
  });

  describe('ping', () => {
    it('reports up with connection latency when the probe succeeds', async () => {
      queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const result = await indicator.ping();

      expect(queryRaw).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('up');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.timestamp).toBe('string');
      expect(result.error).toBeUndefined();
    });

    it('reports down with the error class and message when the database is unreachable', async () => {
      queryRaw.mockRejectedValue(
        Object.assign(new Error('Can\'t reach database server'), {
          name: 'PrismaClientInitializationError',
        }),
      );

      const result = await indicator.ping();

      expect(result.status).toBe('down');
      expect(result.error).toBe('PrismaClientInitializationError');
      expect(result.message).toBe("Can't reach database server");
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('reports down when the connection pool is exhausted', async () => {
      queryRaw.mockRejectedValue(
        Object.assign(new Error('Timed out fetching a new connection'), {
          name: 'PrismaClientInitializationError',
        }),
      );

      const result = await indicator.ping();

      expect(result.status).toBe('down');
      expect(result.message).toContain('connection');
    });

    it('never rejects, even for a non-Error rejection', async () => {
      queryRaw.mockRejectedValue('kaboom');

      const result = await indicator.ping();

      expect(result.status).toBe('down');
      // The timeout wrapper normalises thrown primitives into an Error.
      expect(result.error).toBe('Error');
      expect(result.message).toBe('kaboom');
    });

    it('reports down once the probe exceeds the timeout', async () => {
      // A probe that never settles, mimicking a hung or pool-starved database.
      queryRaw.mockReturnValue(new Promise(() => undefined));

      const result = await indicator.ping(10);

      expect(result.status).toBe('down');
      expect(result.message).toContain('timed out after 10ms');
    });

    it('skips the timeout wrapper when a non-positive timeout is supplied', async () => {
      queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const result = await indicator.ping(0);

      expect(result.status).toBe('up');
    });
  });

  describe('check', () => {
    it('returns a standard Terminus up status keyed by `database`', async () => {
      queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const result = await indicator.check();

      expect(result).toHaveProperty('database');
      expect(result.database.status).toBe('up');
      expect(result.database.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.database.timestamp).toBeDefined();
    });

    it('honours a custom key', async () => {
      queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const result = await indicator.check('primary-db');

      expect(result).toHaveProperty('primary-db');
      expect(result).not.toHaveProperty('database');
    });

    it('returns a standard Terminus down status with latency and error details', async () => {
      queryRaw.mockRejectedValue(
        Object.assign(new Error('connection terminated'), { name: 'PrismaClientKnownRequestError' }),
      );

      const result = await indicator.check();

      expect(result.database.status).toBe('down');
      expect(result.database.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.database.error).toBe('PrismaClientKnownRequestError');
      expect(result.database.message).toBe('connection terminated');
    });

    it('does not include an error key when the database is healthy', async () => {
      queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const result = await indicator.check();

      expect(result.database).not.toHaveProperty('error');
      expect(result.database).not.toHaveProperty('message');
    });
  });
});
