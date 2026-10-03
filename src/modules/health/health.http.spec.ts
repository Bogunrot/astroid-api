import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { INestApplication, RequestMethod } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { HealthController } from './health.controller';
import { PrismaHealthIndicator } from './indicators/prisma.health';
import { RedisHealthIndicator } from './indicators/redis.health';
import { StellarHealthIndicator } from './indicators/stellar.health';
import { DatabaseMigrationHealthIndicator } from './indicators/database-migration.health';

/**
 * HTTP-level coverage for the orchestrator probes: real routing, the global
 * authentication guard, and the same prefix exclusions `main.ts` applies. The
 * indicators are stubbed so dependency outages can be simulated
 * deterministically.
 */
describe('Health probes over HTTP', () => {
  let app: INestApplication;
  let baseUrl: string;

  const dbIndicator = { check: vi.fn() };
  const redisIndicator = { checkHealth: vi.fn() };

  const databaseUp = () => ({
    database: { status: 'up', latencyMs: 3, timestamp: new Date().toISOString() },
  });
  const cacheUp = () => ({ status: 'up', latencyMs: 1, timestamp: new Date().toISOString() });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: PrismaHealthIndicator, useValue: dbIndicator },
        { provide: RedisHealthIndicator, useValue: redisIndicator },
        { provide: StellarHealthIndicator, useValue: { checkHealth: vi.fn() } },
        { provide: DatabaseMigrationHealthIndicator, useValue: { checkHealth: vi.fn() } },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1', {
      exclude: [
        { path: 'health/live', method: RequestMethod.GET },
        { path: 'health/ready', method: RequestMethod.GET },
      ],
    });
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    dbIndicator.check.mockReset().mockResolvedValue(databaseUp());
    redisIndicator.checkHealth.mockReset().mockResolvedValue(cacheUp());
  });

  it('serves GET /health/live without credentials and outside the API prefix', async () => {
    const res = await fetch(`${baseUrl}/health/live`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'up' });
  });

  it('serves GET /health/ready without credentials with 200 when dependencies are up', async () => {
    const res = await fetch(`${baseUrl}/health/ready`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'up',
      services: { database: { status: 'up' }, cache: { status: 'up' } },
    });
  });

  it('answers GET /health/ready with 503 and structured detail during a database outage', async () => {
    dbIndicator.check.mockResolvedValue({
      database: {
        status: 'down',
        latencyMs: 2000,
        timestamp: new Date().toISOString(),
        error: 'Error',
        message: 'Database health check timed out after 2000ms',
      },
    });

    const res = await fetch(`${baseUrl}/health/ready`);

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      status: 'down',
      services: {
        database: { status: 'down', error: 'Database health check timed out after 2000ms' },
        cache: { status: 'up' },
      },
    });
  });

  it('keeps GET /health/live at 200 during a database outage', async () => {
    dbIndicator.check.mockResolvedValue({ database: { status: 'down' } });

    const res = await fetch(`${baseUrl}/health/live`);

    expect(res.status).toBe(200);
  });

  it('keeps the diagnostic routes under the API prefix and public', async () => {
    const res = await fetch(`${baseUrl}/api/v1/health/database`);

    expect(res.status).toBe(200);
  });
});
