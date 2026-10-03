import { Redis } from 'ioredis';

/** Outcome of recording one request against a sliding-window limit. */
export interface SlidingWindowHit {
  /** Whether the request fits within the limit (and was therefore counted). */
  allowed: boolean;
  /** Requests counted in the current window, including this one when allowed. */
  count: number;
  /** Epoch ms at which the oldest counted request leaves the window, freeing a slot. */
  resetAt: number;
}

/**
 * A sliding-window log: each allowed request is recorded with its timestamp
 * and the limit applies to the requests seen in the trailing `windowMs`.
 * Rejected requests are not recorded, so a client that keeps retrying while
 * limited regains capacity as soon as its oldest request ages out.
 */
export interface SlidingWindowStore {
  hit(key: string, limit: number, windowMs: number, now: number): Promise<SlidingWindowHit>;
}

/**
 * Atomic sliding-window check-and-record, executed in one round trip so every
 * API replica observes one consistent log per key.
 *
 * KEYS[1] = sorted-set key (members are request ids, scores are epoch ms)
 * ARGV[1] = now (epoch ms)
 * ARGV[2] = window (ms)
 * ARGV[3] = limit
 * ARGV[4] = unique member id for this request
 * returns  { allowed (0|1), count, resetAt (epoch ms) }
 */
const SLIDING_WINDOW_SCRIPT = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)

local count = redis.call('ZCARD', KEYS[1])
local allowed = 0
if count < limit then
  redis.call('ZADD', KEYS[1], now, ARGV[4])
  count = count + 1
  allowed = 1
end

local resetAt = now + window
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
if oldest[2] then
  resetAt = tonumber(oldest[2]) + window
end

redis.call('PEXPIRE', KEYS[1], window)

return {allowed, count, resetAt}
`;

/** Redis-backed store shared by every API instance. */
export class RedisSlidingWindowStore implements SlidingWindowStore {
  private sequence = 0;

  constructor(private readonly redis: Redis) {}

  /** True when the client can serve commands right now without queueing. */
  get isReady(): boolean {
    return this.redis.status === 'ready';
  }

  async hit(key: string, limit: number, windowMs: number, now: number): Promise<SlidingWindowHit> {
    this.sequence = (this.sequence + 1) % Number.MAX_SAFE_INTEGER;
    const member = `${now}:${process.pid}:${this.sequence}:${Math.random().toString(36).slice(2, 10)}`;
    const [allowed, count, resetAt] = (await this.redis.eval(
      SLIDING_WINDOW_SCRIPT,
      1,
      key,
      now,
      windowMs,
      limit,
      member,
    )) as [number, number, number];

    return { allowed: Number(allowed) === 1, count: Number(count), resetAt: Number(resetAt) };
  }
}

/**
 * Per-process store with the same semantics as {@link RedisSlidingWindowStore}.
 * Used when Redis is unavailable so public endpoints keep a (per-instance)
 * limit instead of failing open during an outage.
 */
export class MemorySlidingWindowStore implements SlidingWindowStore {
  private readonly log = new Map<string, number[]>();
  private lastSweep = 0;

  async hit(key: string, limit: number, windowMs: number, now: number): Promise<SlidingWindowHit> {
    this.sweep(windowMs, now);

    const threshold = now - windowMs;
    const timestamps = (this.log.get(key) ?? []).filter((t) => t > threshold);

    let allowed = false;
    if (timestamps.length < limit) {
      timestamps.push(now);
      allowed = true;
    }

    if (timestamps.length > 0) {
      this.log.set(key, timestamps);
    } else {
      this.log.delete(key);
    }

    return {
      allowed,
      count: timestamps.length,
      resetAt: (timestamps[0] ?? now) + windowMs,
    };
  }

  /** Number of keys currently tracked (exposed for tests and diagnostics). */
  get size(): number {
    return this.log.size;
  }

  /** Drops keys whose newest entry has aged out, at most once per window. */
  private sweep(windowMs: number, now: number): void {
    if (now - this.lastSweep < windowMs) {
      return;
    }
    this.lastSweep = now;
    const threshold = now - windowMs;
    for (const [key, timestamps] of this.log) {
      if (timestamps[timestamps.length - 1] <= threshold) {
        this.log.delete(key);
      }
    }
  }
}
