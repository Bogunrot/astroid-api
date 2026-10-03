import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

import { RedisThrottlerStorage } from './redis-throttler.storage';

type EvalArgs = [script: string, numKeys: number, ...args: Array<string | number>];

function makeStorage(evalResult?: unknown, evalError?: Error) {
  const eval_ = vi.fn();
  if (evalError) {
    eval_.mockRejectedValue(evalError);
  } else {
    eval_.mockResolvedValue(evalResult ?? [1, 60, 0, 0]);
  }
  const redis = { eval: eval_ } as unknown as Redis;
  return { eval_, storage: new RedisThrottlerStorage(redis) };
}

describe('RedisThrottlerStorage', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('increment', () => {
    it('maps the Lua tuple onto the ThrottlerStorageRecord contract', async () => {
      const { storage } = makeStorage([7, 42, 1, 30]);

      const record = await storage.increment('route-hash', 60_000, 5, 60_000, 'api');

      expect(record).toEqual({
        totalHits: 7,
        timeToExpire: 42,
        isBlocked: true,
        timeToBlockExpire: 30,
      });
    });

    it('reports an unblocked request as isBlocked false', async () => {
      const { storage } = makeStorage([3, 58, 0, 0]);

      const record = await storage.increment('route-hash', 60_000, 5, 60_000, 'api');

      expect(record.isBlocked).toBe(false);
      expect(record.timeToBlockExpire).toBe(0);
    });

    it('coerces every field to a number (Redis may return strings)', async () => {
      const { storage } = makeStorage(['4', '55', '0', '0']);

      const record = await storage.increment('route-hash', 60_000, 5, 60_000, 'auth');

      expect(record).toEqual({ totalHits: 4, timeToExpire: 55, isBlocked: false, timeToBlockExpire: 0 });
    });

    it('runs the script with the throttler-scoped key and the resolved limits', async () => {
      const { eval_, storage } = makeStorage();

      await storage.increment('route-hash', 30_000, 10, 30_000, 'auth');

      expect(eval_).toHaveBeenCalledTimes(1);
      const [script, numKeys, key, ttl, limit, blockDuration, now] = eval_.mock.calls[0] as EvalArgs;
      expect(script).toContain('HSET');
      expect(numKeys).toBe(1);
      expect(key).toBe('astroid:throttler:auth:route-hash');
      expect(ttl).toBe(30_000);
      expect(limit).toBe(10);
      expect(blockDuration).toBe(30_000);
      expect(typeof now).toBe('number');
      expect(now as number).toBeLessThanOrEqual(Date.now());
    });

    it('namespaces counters per throttler so tiers never collide', async () => {
      const api = makeStorage();
      const auth = makeStorage();

      await api.storage.increment('same-hash', 60_000, 5, 60_000, 'api');
      await auth.storage.increment('same-hash', 60_000, 5, 60_000, 'auth');

      const apiKey = (api.eval_.mock.calls[0] as EvalArgs)[2];
      const authKey = (auth.eval_.mock.calls[0] as EvalArgs)[2];
      expect(apiKey).not.toBe(authKey);
    });
  });

  describe('resilience', () => {
    it('fails open when Redis is unreachable instead of breaking the request', async () => {
      const { storage } = makeStorage(undefined, new Error('connect ECONNREFUSED 127.0.0.1:6379'));

      const record = await storage.increment('route-hash', 60_000, 5, 60_000, 'api');

      expect(record).toEqual({
        totalHits: 1,
        timeToExpire: 60,
        isBlocked: false,
        timeToBlockExpire: 0,
      });
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.stringContaining('allowing request: connect ECONNREFUSED'),
      );
    });

    it('never rejects so a Redis outage cannot take the API down', async () => {
      const { storage } = makeStorage(undefined, new Error('READONLY You can not write against a read only replica'));

      await expect(storage.increment('route-hash', 60_000, 5, 60_000, 'api')).resolves.toMatchObject({
        isBlocked: false,
      });
    });
  });
});
