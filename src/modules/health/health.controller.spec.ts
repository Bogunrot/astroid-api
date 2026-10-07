import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Response } from 'express';
import { HealthController } from './health.controller';
import { PrismaHealthIndicator } from './indicators/prisma.health';
import { RedisHealthIndicator } from './indicators/redis.health';
import { StellarHealthIndicator } from './indicators/stellar.health';
import { DatabaseMigrationHealthIndicator } from './indicators/database-migration.health';

describe('HealthController', () => {
  let controller: HealthController;
  let dbHealth: { check: ReturnType<typeof vi.fn> };
  let redisHealth: { checkHealth: ReturnType<typeof vi.fn> };
  let stellarHealth: { checkHealth: ReturnType<typeof vi.fn> };
  let migrationHealth: { isEnabled: boolean; checkHealth: ReturnType<typeof vi.fn> };
  let res: Partial<Response>;

  /** Builds the Terminus result map the Prisma indicator returns. */
  const terminus = (overrides: Record<string, unknown> = {}) => ({
    database: {
      status: 'up',
      latencyMs: 5,
      timestamp: new Date().toISOString(),
      ...overrides,
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();

    dbHealth = { check: vi.fn().mockResolvedValue(terminus()) };
    redisHealth = {
      checkHealth: vi.fn().mockResolvedValue({
        status: 'up',
        latencyMs: 2,
        timestamp: new Date().toISOString(),
      }),
    };
    stellarHealth = {
      checkHealth: vi.fn().mockResolvedValue({
        status: 'up',
        timestamp: new Date().toISOString(),
        network: 'testnet',
        horizon: { status: 'up', latencyMs: 50, url: 'https://horizon' },
        sorobanRpc: { status: 'up', latencyMs: 40, url: 'https://soroban' },
      }),
    };
    migrationHealth = {
      isEnabled: true,
      checkHealth: vi.fn().mockResolvedValue({
        status: 'up',
        timestamp: new Date().toISOString(),
        pendingMigrations: 0,
        lastMigrationName: '2026_init',
        lastMigrationApplied: new Date().toISOString(),
      }),
    };

    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    controller = new HealthController(
      dbHealth as unknown as PrismaHealthIndicator,
      redisHealth as unknown as RedisHealthIndicator,
      stellarHealth as unknown as StellarHealthIndicator,
      migrationHealth as unknown as DatabaseMigrationHealthIndicator,
    );
  });

  describe('GET /health/live', () => {
    it('returns 200 with process uptime without probing any dependency', () => {
      controller.live(res as Response);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'up',
          timestamp: expect.any(String),
          uptimeSeconds: expect.any(Number),
        }),
      );
      expect(dbHealth.check).not.toHaveBeenCalled();
      expect(redisHealth.checkHealth).not.toHaveBeenCalled();
    });

    it('stays 200 during a database outage', () => {
      dbHealth.check.mockRejectedValue(new Error('ECONNREFUSED'));

      controller.live(res as Response);

      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe('GET /health/ready', () => {
    it('returns 200 with per-dependency status when database and cache are up', async () => {
      await controller.ready(res as Response);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        status: 'up',
        timestamp: expect.any(String),
        services: {
          database: expect.objectContaining({ status: 'up', latencyMs: 5 }),
          cache: expect.objectContaining({ status: 'up', latencyMs: 2 }),
        },
      });
    });

    it('returns 503 during a simulated database outage', async () => {
      dbHealth.check.mockResolvedValue(
        terminus({ status: 'down', error: 'Error', message: 'Database health check timed out after 2000ms' }),
      );

      await controller.ready(res as Response);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'down',
          services: {
            database: expect.objectContaining({
              status: 'down',
              error: 'Database health check timed out after 2000ms',
            }),
            cache: expect.objectContaining({ status: 'up' }),
          },
        }),
      );
    });

    it('returns 503 during a simulated cache outage', async () => {
      redisHealth.checkHealth.mockResolvedValue({
        status: 'down',
        latencyMs: 2000,
        timestamp: new Date().toISOString(),
        error: 'Redis health check timed out after 2000ms',
      });

      await controller.ready(res as Response);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'down',
          services: expect.objectContaining({
            database: expect.objectContaining({ status: 'up' }),
            cache: expect.objectContaining({ status: 'down' }),
          }),
        }),
      );
    });

    it('returns 503 when the database indicator produces no result', async () => {
      dbHealth.check.mockResolvedValue({});

      await controller.ready(res as Response);

      expect(res.status).toHaveBeenCalledWith(503);
    });

    it('probes only critical dependencies, so an external Stellar outage cannot fail readiness', async () => {
      stellarHealth.checkHealth.mockResolvedValue({ status: 'down', timestamp: 'now' });

      await controller.ready(res as Response);

      expect(stellarHealth.checkHealth).not.toHaveBeenCalled();
      expect(migrationHealth.checkHealth).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  it('returns liveness payload with status up', () => {
    const response = controller.getLiveness();
    expect(response.status).toBe('up');
    expect(response.timestamp).toBeDefined();
  });

  it('exposes the orchestration liveness and readiness routes', () => {
    expect(Reflect.getMetadata(PATH_METADATA, HealthController.prototype.getLiveness))
      .toContain('live');
    expect(Reflect.getMetadata(PATH_METADATA, HealthController.prototype.getReadiness))
      .toContain('ready');
  });

  describe('GET /health/database', () => {
    it('returns 200 with status and latency when the database answers', async () => {
      await controller.getDatabase(res as Response);

      expect(dbHealth.check).toHaveBeenCalledWith('database');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'up', latencyMs: 5, timestamp: expect.any(String) }),
      );
    });

    it('returns 503 with the failure detail when the probe fails', async () => {
      dbHealth.check.mockResolvedValue(
        terminus({ status: 'down', error: 'PrismaClientInitializationError', message: 'timeout' }),
      );

      await controller.getDatabase(res as Response);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'down', error: 'timeout' }),
      );
    });

    it('returns 503 when the indicator produces no result at all', async () => {
      dbHealth.check.mockResolvedValue({});

      await controller.getDatabase(res as Response);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'down' }));
    });

    it('reports only the database, so a broken Redis cannot mask a DB outage', async () => {
      dbHealth.check.mockResolvedValue(
        terminus({ status: 'down', message: 'connection pool exhausted' }),
      );
      redisHealth.checkHealth.mockResolvedValue({ status: 'up', timestamp: 'now' });

      await controller.getDatabase(res as Response);

      expect(redisHealth.checkHealth).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'down', error: 'connection pool exhausted' }),
      );
    });
  });

  describe('GET /health/redis', () => {
    it('returns 200 with status and latency when the PING answers', async () => {
      await controller.getRedis(res as Response);

      expect(redisHealth.checkHealth).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'up', latencyMs: 2, timestamp: expect.any(String) }),
      );
    });

    it('returns 503 with the failure detail when the ping fails', async () => {
      redisHealth.checkHealth.mockResolvedValue({
        status: 'down',
        latencyMs: 3000,
        timestamp: new Date().toISOString(),
        error: 'Redis ping timed out',
      });

      await controller.getRedis(res as Response);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'down', error: 'Redis ping timed out', latencyMs: 3000 }),
      );
    });

    it('reports only Redis, so a broken database cannot mask a Redis outage', async () => {
      redisHealth.checkHealth.mockResolvedValue({
        status: 'down',
        latencyMs: 12,
        timestamp: new Date().toISOString(),
        error: 'connect ECONNREFUSED',
      });
      dbHealth.check.mockResolvedValue(terminus({ status: 'down', message: 'pool exhausted' }));

      await controller.getRedis(res as Response);

      expect(dbHealth.check).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'down', error: 'connect ECONNREFUSED' }),
      );
    });
  });

  it('returns 200 OK when all services are healthy', async () => {
    await controller.getReadiness(res as Response);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'up',
        services: expect.objectContaining({
          database: expect.objectContaining({ status: 'up', latencyMs: 5 }),
          redis: expect.objectContaining({ status: 'up' }),
          stellar: expect.objectContaining({ status: 'up' }),
          migrations: expect.objectContaining({ status: 'up' }),
        }),
      }),
    );
  });

  it('asks the Prisma indicator for a result keyed by `database`', async () => {
    await controller.getReadiness(res as Response);

    expect(dbHealth.check).toHaveBeenCalledWith('database');
  });

  it('flattens the Terminus message into the flat `error` field', async () => {
    dbHealth.check.mockResolvedValue(
      terminus({ status: 'down', error: 'PrismaClientInitializationError', message: 'no route to host' }),
    );

    await controller.getReadiness(res as Response);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        services: expect.objectContaining({
          database: expect.objectContaining({
            status: 'down',
            error: 'no route to host',
            latencyMs: 5,
          }),
        }),
      }),
    );
  });

  it('returns 503 SERVICE UNAVAILABLE when database is down', async () => {
    dbHealth.check.mockResolvedValue(
      terminus({
        status: 'down',
        error: 'PrismaClientInitializationError',
        message: 'PrismaClientInitializationError',
      }),
    );

    await controller.getReadiness(res as Response);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'down',
        services: expect.objectContaining({
          database: expect.objectContaining({ status: 'down' }),
        }),
      }),
    );
  });

  it('returns 503 SERVICE UNAVAILABLE when the database indicator returns no result', async () => {
    dbHealth.check.mockResolvedValue({});

    await controller.getReadiness(res as Response);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        services: expect.objectContaining({
          database: expect.objectContaining({ status: 'down' }),
        }),
      }),
    );
  });

  it('returns 503 SERVICE UNAVAILABLE when redis is down', async () => {
    redisHealth.checkHealth.mockResolvedValue({
      status: 'down',
      latencyMs: 3000,
      timestamp: new Date().toISOString(),
      error: 'Redis ping timed out',
    });

    await controller.getReadiness(res as Response);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'down',
        services: expect.objectContaining({
          redis: expect.objectContaining({ status: 'down' }),
        }),
      }),
    );
  });

  it('serves the same payload from the default health route', async () => {
    await controller.check(res as Response);

    expect(res.status).toHaveBeenCalledWith(200);
  });
});
