/**
 * DI token for the app's shared ioredis client. Provided by {@link LocksModule}
 * as a singleton and consumed by {@link RedisLock} and the Redis-backed
 * throttler storage — one connection pool instead of one per feature.
 */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
