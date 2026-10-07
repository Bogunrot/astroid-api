import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { randomUUID } from 'crypto';
import { LockNotAcquiredException } from '../exceptions/domain.exception';
import { REDIS_CLIENT } from './locks.constants';

/**
 * The Lua script used to release a lock safely. It only deletes the key when
 * the value still matches the token this process holds, which prevents a
 * process from releasing a lock that already expired and was re-acquired by
 * another process. This is the canonical, race-free Redlock-style release.
 */
const RELEASE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

/** Default lock lifetime in milliseconds (prevents deadlocks). */
export const DEFAULT_LOCK_TTL_MS = 5000;

/** A handle that releases the previously-acquired distributed lock. */
export type LockRelease = () => Promise<void>;

/**
 * Distributed lock service backed by a shared Redis instance.
 *
 * Uses the atomic `SET key token PX ttl NX` command to acquire a lock with a
 * TTL (so a crashed holder can never deadlock a resource), and releases it via
 * the {@link RELEASE_SCRIPT} Lua script so a lock is only released by the
 * process that actually holds it.
 *
 * When the lock is already held by another process, {@link acquire} and
 * {@link withLock} throw a {@link LockNotAcquiredException} (409), giving
 * callers a graceful, retryable conflict instead of a raw Redis failure.
 *
 * Usage:
 * ```
 * await redisLock.withLock(`agent:${id}`, () => this.repository.update(id, data));
 * ```
 */
@Injectable()
export class RedisLock {
  // The shared client is owned by LocksModule and closed in the shutdown
  // coordinator's `redis` phase, after queues have drained.
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Acquires a distributed lock with automatic expiration.
   * @param key - Lock key (should be unique per resource).
   * @param ttl - Time to live in milliseconds (prevents deadlocks).
   * @param attempts - Number of acquisition attempts before giving up (>= 1).
   * @param retryDelayMs - Delay between attempts in milliseconds.
   * @returns A {@link LockRelease} function that atomically releases the lock.
   * @throws LockNotAcquiredException when the lock cannot be acquired.
   */
  async acquire(
    key: string,
    ttl: number = DEFAULT_LOCK_TTL_MS,
    attempts = 1,
    retryDelayMs = 100,
  ): Promise<LockRelease> {
    const lockKey = this.lockKey(key);
    const token = randomUUID();

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      // SET key token PX ttl NX — only sets when the key does not exist.
      const acquired = await this.redis.set(lockKey, token, 'PX', ttl, 'NX');
      if (acquired === 'OK') {
        return async () => {
          await this.redis.eval(RELEASE_SCRIPT, 1, lockKey, token);
        };
      }
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }

    throw new LockNotAcquiredException(key, { ttlMs: ttl, attempts });
  }

  /**
   * Executes a function while holding a distributed lock, releasing it in a
   * `finally` block even when the handler throws.
   * @param key - Lock key.
   * @param fn - Handler executed while holding the lock.
   * @param ttl - Lock time to live in milliseconds.
   * @returns The result of {@link fn}.
   * @throws LockNotAcquiredException when the lock cannot be acquired.
   */
  async withLock<T>(
    key: string,
    fn: () => Promise<T>,
    ttl: number = DEFAULT_LOCK_TTL_MS,
    attempts = 1,
    retryDelayMs = 100,
  ): Promise<T> {
    const release = await this.acquire(key, ttl, attempts, retryDelayMs);
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  private lockKey(key: string): string {
    return `lock:${key}`;
  }
}
