import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Controller, Get, INestApplication, Logger, Post } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PublicRateLimitGuard } from './public-rate-limit.guard';
import { Public } from '../decorators/public.decorator';
import { AllExceptionsFilter } from '../filters/all-exceptions.filter';
import { REDIS_CLIENT } from '../locks/locks.constants';
import { MemorySlidingWindowStore } from '../throttler/sliding-window.store';

/**
 * Simulates request bursts over real HTTP against a Nest app wired like
 * production: the guard is a global APP_GUARD, errors go through
 * AllExceptionsFilter, and routes live under the `api/v1` prefix.
 *
 * The Redis client is a stand-in whose `eval` reproduces the sliding-window
 * script's contract (`[allowed, count, resetAt]`) on top of the in-memory
 * store, so the Redis code path of the guard is exercised end to end.
 */

const LIMIT = 5;

@Controller('auth')
class AuthController {
  @Public()
  @Post('login')
  login() {
    return { ok: true };
  }
}

@Controller('public')
class PublicCatalogController {
  @Get('status')
  status() {
    return { ok: true };
  }
}

@Controller('agents')
class AgentsController {
  @Get()
  list() {
    return [];
  }
}

function fakeRedis() {
  const store = new MemorySlidingWindowStore();
  return {
    status: 'ready',
    eval: vi.fn(
      async (_script: string, _keys: number, key: string, now: number, windowMs: number, limit: number) => {
        const hit = await store.hit(key, limit, windowMs, now);
        return [hit.allowed ? 1 : 0, hit.count, hit.resetAt];
      },
    ),
  };
}

describe('PublicRateLimitGuard (integration)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let redis: ReturnType<typeof fakeRedis>;

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    redis = fakeRedis();
    const config = {
      getOrThrow: () => ({
        windowSeconds: 60,
        maxRequests: 120,
        public: { enabled: true, maxRequests: LIMIT, windowSeconds: 60, trustProxy: true },
      }),
      get: () => ({ apiPrefix: 'api/v1' }),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController, PublicCatalogController, AgentsController],
      providers: [
        { provide: ConfigService, useValue: config },
        { provide: REDIS_CLIENT, useValue: redis },
        { provide: APP_GUARD, useClass: PublicRateLimitGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    await app.listen(0, '127.0.0.1');
    baseUrl = `${await app.getUrl()}/api/v1`;
  });

  afterAll(async () => {
    await app.close();
  });

  const send = (path: string, ip: string, method = 'GET') =>
    fetch(`${baseUrl}${path}`, { method, headers: { 'x-forwarded-for': ip } });

  it('serves a burst up to the limit, then answers 429 with rate-limit headers', async () => {
    const statuses: number[] = [];
    const remaining: (string | null)[] = [];
    for (let i = 0; i < LIMIT; i++) {
      const res = await send('/auth/login', '198.51.100.10', 'POST');
      statuses.push(res.status);
      remaining.push(res.headers.get('x-ratelimit-remaining'));
    }

    expect(statuses).toEqual(Array(LIMIT).fill(201));
    expect(remaining).toEqual(['4', '3', '2', '1', '0']);

    const limited = await send('/auth/login', '198.51.100.10', 'POST');

    expect(limited.status).toBe(429);
    expect(limited.headers.get('x-ratelimit-limit')).toBe(String(LIMIT));
    expect(limited.headers.get('x-ratelimit-remaining')).toBe('0');
    const reset = Number(limited.headers.get('x-ratelimit-reset'));
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(reset).toBeGreaterThanOrEqual(nowSeconds);
    expect(reset).toBeLessThanOrEqual(nowSeconds + 61);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  });

  it('shares one budget per IP across every public route', async () => {
    const ip = '198.51.100.20';
    for (let i = 0; i < LIMIT; i++) {
      await send(i % 2 === 0 ? '/public/status' : '/auth/login', ip, i % 2 === 0 ? 'GET' : 'POST');
    }

    expect((await send('/public/status', ip)).status).toBe(429);
  });

  it('keeps other IPs unaffected while one IP is limited', async () => {
    for (let i = 0; i <= LIMIT; i++) {
      await send('/public/status', '198.51.100.30');
    }

    const other = await send('/public/status', '198.51.100.31');
    expect(other.status).toBe(200);
    expect(other.headers.get('x-ratelimit-remaining')).toBe(String(LIMIT - 1));
  });

  it('never limits or annotates authenticated routes', async () => {
    const ip = '198.51.100.40';
    for (let i = 0; i < LIMIT * 2; i++) {
      const res = await send('/agents', ip);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-ratelimit-limit')).toBeNull();
    }
  });

  it('tracks counters through the shared Redis client', () => {
    expect(redis.eval).toHaveBeenCalled();
    expect(redis.eval.mock.calls.every(([, , key]) => String(key).startsWith('rate-limit:public:ip:'))).toBe(
      true,
    );
  });
});
