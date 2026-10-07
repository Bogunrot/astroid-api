import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'idempotent_request';

export interface IdempotentOptions {
  ttl?: number; // TTL in seconds, defaults to 86400 (24 hours)
}

/**
 * Marks a controller method as requiring idempotency enforcement.
 * When present, requests containing an Idempotency-Key header will be cached
 * and deduplicated in Redis.
 */
export const Idempotent = (options: IdempotentOptions = {}) =>
  SetMetadata(IDEMPOTENT_KEY, options);
