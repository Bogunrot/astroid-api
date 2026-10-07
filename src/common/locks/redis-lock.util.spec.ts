import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Redis } from 'ioredis';
import { RedisLock } from './redis-lock.util';
import { LockNotAcquiredException } from '../exceptions/domain.exception';

describe('RedisLock', () => {
  let redis: {
    set: ReturnType<typeof vi.fn>;
    eval: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  };
  let lock: RedisLock;

  beforeEach(() => {
    redis = {
      set: vi.fn().mockResolvedValue('OK'),
      eval: vi.fn().mockResolvedValue(1),
      disconnect: vi.fn(),
    };
    lock = new RedisLock(redis as unknown as Redis);
  });

  describe('acquire', () => {
    it('acquires a lock with SET NX and an expiry', async () => {
      const release = await lock.acquire('agent-1', 1000);

      expect(release).toEqual(expect.any(Function));
      expect(redis.set).toHaveBeenCalledWith(
        'lock:agent-1',
        expect.any(String),
        'PX',
        1000,
        'NX',
      );
    });

    it('prefixes the lock key with lock:', async () => {
      await lock.acquire('agent-1');
      expect(redis.set.mock.calls[0][0]).toBe('lock:agent-1');
    });

    it('uses a random token as the lock value', async () => {
      await lock.acquire('agent-1');
      expect(redis.set.mock.calls[0][1]).toEqual(expect.any(String));
    });

    it('throws LockNotAcquiredException when the lock is already held', async () => {
      redis.set.mockResolvedValue(null);

      await expect(lock.acquire('agent-1')).rejects.toBeInstanceOf(LockNotAcquiredException);
    });

    it('retries acquisition up to the requested number of attempts', async () => {
      redis.set.mockResolvedValueOnce(null).mockResolvedValueOnce('OK');

      const release = await lock.acquire('agent-1', 5000, 2, 0);

      expect(release).toEqual(expect.any(Function));
      expect(redis.set).toHaveBeenCalledTimes(2);
    });

    it('gives up after exhausting all attempts', async () => {
      redis.set.mockResolvedValue(null);

      await expect(lock.acquire('agent-1', 5000, 3, 0)).rejects.toBeInstanceOf(
        LockNotAcquiredException,
      );
      expect(redis.set).toHaveBeenCalledTimes(3);
    });
  });

  describe('release', () => {
    it('releases via the atomic compare-and-delete Lua script with the same token', async () => {
      const release = await lock.acquire('agent-1');
      await release();

      expect(redis.eval).toHaveBeenCalledTimes(1);
      expect(redis.eval.mock.calls[0][0]).toContain('redis.call');
      expect(redis.eval.mock.calls[0][1]).toBe(1);
      expect(redis.eval.mock.calls[0][2]).toBe('lock:agent-1');
      expect(redis.eval.mock.calls[0][3]).toBe(redis.set.mock.calls[0][1]);
    });
  });

  describe('withLock', () => {
    it('executes the handler and releases the lock afterwards', async () => {
      const fn = vi.fn().mockResolvedValue('done');

      const result = await lock.withLock('agent-1', fn);

      expect(result).toBe('done');
      expect(redis.eval).toHaveBeenCalledTimes(1);
    });

    it('releases the lock even when the handler throws', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('boom'));

      await expect(lock.withLock('agent-1', fn)).rejects.toThrow('boom');
      expect(redis.eval).toHaveBeenCalledTimes(1);
    });

    it('fails fast without invoking the handler when the lock is held', async () => {
      redis.set.mockResolvedValue(null);
      const fn = vi.fn();

      await expect(lock.withLock('agent-1', fn)).rejects.toBeInstanceOf(LockNotAcquiredException);
      expect(fn).not.toHaveBeenCalled();
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('applies the default TTL when none is provided', async () => {
      await lock.withLock('agent-1', vi.fn().mockResolvedValue(undefined));
      expect(redis.set).toHaveBeenCalledWith('lock:agent-1', expect.any(String), 'PX', 5000, 'NX');
    });

    it('passes through retry attempts and delay to acquire', async () => {
      redis.set.mockResolvedValueOnce(null).mockResolvedValueOnce('OK');

      const fn = vi.fn().mockResolvedValue('done');
      const result = await lock.withLock('agent-1', fn, 5000, 2, 0);

      expect(result).toBe('done');
      expect(redis.set).toHaveBeenCalledTimes(2);
    });

    it('retries and eventually fails when lock remains held', async () => {
      redis.set.mockResolvedValue(null);
      const fn = vi.fn();

      await expect(lock.withLock('agent-1', fn, 5000, 3, 0)).rejects.toBeInstanceOf(
        LockNotAcquiredException,
      );
      expect(fn).not.toHaveBeenCalled();
      expect(redis.set).toHaveBeenCalledTimes(3);
    });

    it('still releases the lock when handler throws with retry params', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('boom'));

      await expect(lock.withLock('agent-1', fn, 5000, 2, 0)).rejects.toThrow('boom');
      expect(redis.eval).toHaveBeenCalledTimes(1);
    });

    it('allows only one concurrent handler for the same resource key', async () => {
      let held = false;
      let finishHandler!: () => void;
      let signalEntered!: () => void;
      const handlerGate = new Promise<void>((resolve) => {
        finishHandler = resolve;
      });
      const handlerEntered = new Promise<void>((resolve) => {
        signalEntered = resolve;
      });
      redis.set.mockImplementation(async () => {
        if (held) return null;
        held = true;
        return 'OK';
      });
      redis.eval.mockImplementation(async () => {
        held = false;
        return 1;
      });
      const handler = vi.fn(async () => {
        signalEntered();
        await handlerGate;
      });

      const first = lock.withLock('wallet:1', handler);
      await handlerEntered;

      await expect(lock.withLock('wallet:1', handler)).rejects.toBeInstanceOf(
        LockNotAcquiredException,
      );
      expect(handler).toHaveBeenCalledTimes(1);

      finishHandler();
      await first;
      expect(held).toBe(false);
    });
  });

  it('does not close the shared client it does not own', () => {
    expect((lock as unknown as Record<string, unknown>).onModuleDestroy).toBeUndefined();
    expect(redis.disconnect).not.toHaveBeenCalled();
  });
});
