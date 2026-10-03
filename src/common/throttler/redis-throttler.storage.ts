import { Injectable, Logger } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { Redis } from 'ioredis';

/** The record `@nestjs/throttler` expects back from `increment`. */
type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

/**
 * Atomic rate-limit script, executed as a single Redis transaction-free round
 * trip so concurrent requests from every API instance observe one consistent
 * counter (the whole point of moving off the in-process `ThrottlerStorageService`).
 *
 * State lives in a single hash with two fields:
 *   - `hits`       : requests seen in the current window
 *   - `blockUntil` : epoch ms until which the key is blocked, 0 when not blocked
 *
 * Behaviour mirrors `ThrottlerStorageService` exactly:
 *   1. an active block short-circuits without consuming quota
 *   2. an expired block resets the window before counting the new request
 *   3. exceeding `limit` opens a block that lasts `blockDuration`
 *   4. the key TTL always covers both the window and any open block
 *
 * KEYS[1] = throttle key
 * ARGV[1] = window ttl (ms)
 * ARGV[2] = limit (hits per window)
 * ARGV[3] = block duration (ms)
 * ARGV[4] = now (epoch ms)
 * returns  { totalHits, timeToExpire, isBlocked, timeToBlockExpire } in seconds
 */
const INCREMENT_SCRIPT = `
local now = tonumber(ARGV[4])
local ttlMs = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockMs = tonumber(ARGV[3])

local function toSeconds(ms)
  if ms <= 0 then
    return 0
  end
  return math.ceil(ms / 1000)
end

local state = redis.call('HMGET', KEYS[1], 'hits', 'blockUntil')
local hits = tonumber(state[1]) or 0
local blockUntil = tonumber(state[2]) or 0
local windowTtl = redis.call('PTTL', KEYS[1])

if blockUntil > now then
  return {hits, toSeconds(windowTtl), 1, toSeconds(blockUntil - now)}
end

-- A previous block expired: start from a clean window like the in-memory store.
if blockUntil > 0 then
  hits = 0
end

hits = hits + 1

local timeToExpire = windowTtl
if timeToExpire <= 0 then
  timeToExpire = ttlMs
end

local isBlocked = 0
local timeToBlockExpire = 0
if hits > limit then
  isBlocked = 1
  blockUntil = now + blockMs
  timeToBlockExpire = blockMs
end

redis.call('HSET', KEYS[1], 'hits', hits, 'blockUntil', blockUntil)

local keyTtl = timeToExpire
if blockUntil > now and (blockUntil - now) > keyTtl then
  keyTtl = blockUntil - now
end
redis.call('PEXPIRE', KEYS[1], keyTtl)

return {hits, toSeconds(timeToExpire), isBlocked, toSeconds(timeToBlockExpire)}
`;

/** Result shape returned by {@link INCREMENT_SCRIPT} as a flat array of numbers. */
type IncrementScriptResult = [totalHits: number, timeToExpire: number, isBlocked: number, timeToBlockExpire: number];

/**
 * Redis-backed storage for `@nestjs/throttler`.
 *
 * Replaces the library's in-memory `ThrottlerStorageService` so rate-limit
 * counters are shared by every API instance behind a load balancer — without
 * this, each pod would enforce the configured limit independently and an
 * attacker could multiply their effective quota by the replica count.
 *
 * Fail-open policy: if Redis is unreachable the request is allowed and a
 * warning is logged. A rate limiter is a best-effort abuse control; turning a
 * Redis outage into a full API outage would be a strictly worse trade, and it
 * matches the policy already used by `SlidingWindowThrottlerGuard`.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  constructor(private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    try {
      const result = (await this.redis.eval(
        INCREMENT_SCRIPT,
        1,
        this.namespacedKey(throttlerName, key),
        ttl,
        limit,
        blockDuration,
        Date.now(),
      )) as IncrementScriptResult;

      const [totalHits, timeToExpire, isBlocked, timeToBlockExpire] = result;
      return {
        totalHits: Number(totalHits),
        timeToExpire: Number(timeToExpire),
        isBlocked: Number(isBlocked) > 0,
        timeToBlockExpire: Number(timeToBlockExpire),
      };
    } catch (error) {
      this.logger.warn(
        `Rate-limit check failed for throttler "${throttlerName}"; allowing request: ${(error as Error).message}`,
      );
      return {
        totalHits: 1,
        timeToExpire: Math.ceil(ttl / 1000),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }

  /** Keeps counters inspectable and collision-free in a shared Redis. */
  private namespacedKey(throttlerName: string, key: string): string {
    return `astroid:throttler:${throttlerName}:${key}`;
  }
}
