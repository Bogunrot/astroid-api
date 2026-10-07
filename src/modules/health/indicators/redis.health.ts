import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../common/locks/locks.constants';

export interface RedisHealthReport {
  status: 'up' | 'down';
  timestamp: string;
  latencyMs: number;
  error?: string;
}

/**
 * Probes the cache store by issuing a `PING` on the application's shared Redis
 * client (provided by `LocksModule` from the validated `REDIS_*` config), so the
 * check exercises the exact connection the API depends on rather than a
 * side-channel client pointed at a default host.
 *
 * Like the database indicator, the probe is:
 *  - **Bounded.** ioredis queues commands while reconnecting, so an unreachable
 *    Redis would otherwise hold the probe open until retries are exhausted.
 *  - **Never throws.** Any failure is reported as `status: 'down'`.
 */
@Injectable()
export class RedisHealthIndicator {
  private readonly logger = new Logger(RedisHealthIndicator.name);

  /** Ceiling on a single probe, in ms. */
  static readonly DEFAULT_TIMEOUT_MS = 2_000;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async checkHealth(
    timeoutMs: number = RedisHealthIndicator.DEFAULT_TIMEOUT_MS,
  ): Promise<RedisHealthReport> {
    const start = Date.now();
    try {
      // A client that has been explicitly closed will never reconnect; fail
      // fast instead of waiting for the timeout.
      if (this.redis.status === 'end') {
        throw new Error('Redis connection is closed');
      }

      const res = await this.withTimeout(this.redis.ping(), timeoutMs);
      const latencyMs = Date.now() - start;

      if (res !== 'PONG') {
        throw new Error(`Unexpected ping response: ${res}`);
      }

      return {
        status: 'up',
        timestamp: new Date().toISOString(),
        latencyMs,
      };
    } catch (error) {
      const latencyMs = Date.now() - start;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Redis health check failed after ${latencyMs}ms: ${message}`);

      return {
        status: 'down',
        timestamp: new Date().toISOString(),
        latencyMs,
        error: message,
      };
    }
  }

  private withTimeout<T>(probe: Promise<T>, timeoutMs: number): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return probe;
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Redis health check timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      probe.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }
}
