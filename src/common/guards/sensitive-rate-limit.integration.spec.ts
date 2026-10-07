import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { INestApplication, Controller, Post, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { Redis } from 'ioredis';
import { AstroidThrottlerGuard } from './throttler.guard';
import { MemorySlidingWindowStore } from '../throttler/sliding-window.store';
import { RedisThrottlerStorage } from '../throttler/redis-throttler.storage';

@Controller('test-sensitive')
class TestSensitiveController {
  @Post('action')
  @UseGuards(AstroidThrottlerGuard)
  action() {
    return { success: true };
  }
}

describe('Sensitive Endpoint Rate Limiting (Integration)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const store = new MemorySlidingWindowStore();
    const fakeRedis = {
      status: 'ready',
      eval: vi.fn(
        async (
          _script: string,
          _keys: number,
          key: string,
          ttl: number,
          limit: number,
          blockDuration: number,
          now: number,
        ) => {
          const hit = await store.hit(key, limit, ttl, now);
          return [
            hit.count,
            Math.ceil((hit.resetAt - now) / 1000),
            hit.allowed ? 0 : 1,
            hit.allowed ? 0 : Math.ceil(blockDuration / 1000),
          ];
        },
      ),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [{ name: 'api', ttl: 60000, limit: 2 }],
          storage: new RedisThrottlerStorage(fakeRedis as unknown as Redis),
        }),
      ],
      controllers: [TestSensitiveController],
      providers: [],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it('enforces rate limit and returns 429 when threshold is exceeded', async () => {
    const send = () =>
      fetch(`${baseUrl}/test-sensitive/action`, {
        method: 'POST',
        headers: { 'x-api-key': 'test-key-123' },
      });

    const res1 = await send();
    expect(res1.status).toBe(201);

    const res2 = await send();
    expect(res2.status).toBe(201);

    const res3 = await send();
    expect(res3.status).toBe(429);
  });
});
