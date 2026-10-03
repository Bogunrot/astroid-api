import { describe, expect, it, vi } from 'vitest';
import { Redis } from 'ioredis';
import { MemorySlidingWindowStore, RedisSlidingWindowStore } from './sliding-window.store';

const WINDOW_MS = 60_000;
const T0 = 1_750_000_000_000;

describe('MemorySlidingWindowStore', () => {
  it('allows requests up to the limit and rejects the next one', async () => {
    const store = new MemorySlidingWindowStore();

    const hits = [];
    for (let i = 0; i < 4; i++) {
      hits.push(await store.hit('ip:1', 3, WINDOW_MS, T0 + i));
    }

    expect(hits.map((h) => h.allowed)).toEqual([true, true, true, false]);
    expect(hits.map((h) => h.count)).toEqual([1, 2, 3, 3]);
  });

  it('reports resetAt as the moment the oldest request leaves the window', async () => {
    const store = new MemorySlidingWindowStore();

    await store.hit('ip:1', 2, WINDOW_MS, T0);
    await store.hit('ip:1', 2, WINDOW_MS, T0 + 1_000);
    const rejected = await store.hit('ip:1', 2, WINDOW_MS, T0 + 2_000);

    expect(rejected.allowed).toBe(false);
    expect(rejected.resetAt).toBe(T0 + WINDOW_MS);
  });

  it('frees capacity as old requests slide out of the window', async () => {
    const store = new MemorySlidingWindowStore();

    await store.hit('ip:1', 2, WINDOW_MS, T0);
    await store.hit('ip:1', 2, WINDOW_MS, T0 + 30_000);
    expect((await store.hit('ip:1', 2, WINDOW_MS, T0 + 59_999)).allowed).toBe(false);

    const afterSlide = await store.hit('ip:1', 2, WINDOW_MS, T0 + WINDOW_MS);
    expect(afterSlide).toMatchObject({ allowed: true, count: 2 });
  });

  it('does not count rejected requests against the window', async () => {
    const store = new MemorySlidingWindowStore();

    await store.hit('ip:1', 1, WINDOW_MS, T0);
    for (let i = 1; i <= 10; i++) {
      await store.hit('ip:1', 1, WINDOW_MS, T0 + i * 1_000);
    }

    expect((await store.hit('ip:1', 1, WINDOW_MS, T0 + WINDOW_MS)).allowed).toBe(true);
  });

  it('tracks each key independently', async () => {
    const store = new MemorySlidingWindowStore();

    await store.hit('ip:1', 1, WINDOW_MS, T0);

    expect((await store.hit('ip:1', 1, WINDOW_MS, T0)).allowed).toBe(false);
    expect((await store.hit('ip:2', 1, WINDOW_MS, T0)).allowed).toBe(true);
  });

  it('evicts idle keys so memory stays bounded', async () => {
    const store = new MemorySlidingWindowStore();

    for (let i = 0; i < 100; i++) {
      await store.hit(`ip:${i}`, 5, WINDOW_MS, T0);
    }
    expect(store.size).toBe(100);

    await store.hit('ip:new', 5, WINDOW_MS, T0 + WINDOW_MS + 1);

    expect(store.size).toBe(1);
  });
});

describe('RedisSlidingWindowStore', () => {
  function makeStore(result: unknown, status = 'ready') {
    const evalFn = vi.fn().mockResolvedValue(result);
    const redis = { eval: evalFn, status } as unknown as Redis;
    return { evalFn, store: new RedisSlidingWindowStore(redis) };
  }

  it('runs the sliding-window script atomically with key and arguments', async () => {
    const { evalFn, store } = makeStore([1, 1, T0 + WINDOW_MS]);

    await store.hit('rate-limit:public:ip:1.2.3.4', 60, WINDOW_MS, T0);

    expect(evalFn).toHaveBeenCalledTimes(1);
    const [script, numKeys, key, now, windowMs, limit, member] = evalFn.mock.calls[0];
    expect(script).toContain('ZREMRANGEBYSCORE');
    expect(script).toContain('ZADD');
    expect(script).toContain('PEXPIRE');
    expect(numKeys).toBe(1);
    expect(key).toBe('rate-limit:public:ip:1.2.3.4');
    expect([now, windowMs, limit]).toEqual([T0, WINDOW_MS, 60]);
    expect(typeof member).toBe('string');
  });

  it('uses a unique member per request so same-millisecond hits are all counted', async () => {
    const { evalFn, store } = makeStore([1, 1, T0]);

    await store.hit('k', 60, WINDOW_MS, T0);
    await store.hit('k', 60, WINDOW_MS, T0);

    expect(evalFn.mock.calls[0][6]).not.toBe(evalFn.mock.calls[1][6]);
  });

  it('maps the script reply onto a hit result', async () => {
    const { store } = makeStore([0, 60, T0 + 5_000]);

    await expect(store.hit('k', 60, WINDOW_MS, T0)).resolves.toEqual({
      allowed: false,
      count: 60,
      resetAt: T0 + 5_000,
    });
  });

  it('reports readiness from the client status', () => {
    expect(makeStore([]).store.isReady).toBe(true);
    expect(makeStore([], 'reconnecting').store.isReady).toBe(false);
  });
});
