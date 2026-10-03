import { Injectable, Logger } from '@nestjs/common';
import { HealthIndicator } from '@nestjs/terminus';
import { PrismaService } from '../../../database/prisma.service';

/** Result of a single database probe, mirroring the other health indicators. */
export interface PrismaPingResult {
  status: 'up' | 'down';
  latencyMs: number;
  timestamp: string;
  /** Error class name when the probe failed, for quick triage. */
  error?: string;
  /** Human-readable failure detail when the probe failed. */
  message?: string;
}

/**
 * Prisma health indicator for NestJS Terminus.
 *
 * Terminates the API's readiness contract for the database by issuing the
 * cheapest possible round trip — `SELECT 1` — and reporting the outcome in
 * Terminus' standard `{ status, ...details }` shape. Terminus' `HealthCheckService`
 * aggregates the returned map and flips the endpoint to `503 Service Unavailable`
 * as soon as any indicator reports `down`, so a degraded database is visible to
 * orchestrators, load balancers and uptime monitoring without extra wiring.
 *
 * Two properties matter for a health check and are guaranteed here:
 *  - **Bounded.** The probe is wrapped in a timeout so a hung or pool-starved
 *    database fails fast instead of holding the readiness request open until the
 *    caller gives up.
 *  - **Never throws.** Transport and driver errors are converted into a `down`
 *    result. An exception escaping a health indicator would surface as a 500 and
 *    lose the per-dependency detail operators need.
 */
@Injectable()
export class PrismaHealthIndicator extends HealthIndicator {
  private readonly logger = new Logger(PrismaHealthIndicator.name);

  /** Ceiling on a single probe, in ms. */
  static readonly DEFAULT_TIMEOUT_MS = 2_000;

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  /**
   * Probes database connectivity and returns a Terminus health result keyed by
   * `key` (default `database`).
   */
  async check(key = 'database', timeoutMs: number = PrismaHealthIndicator.DEFAULT_TIMEOUT_MS) {
    const result = await this.ping(timeoutMs);
    return this.getStatus(key, result.status === 'up', {
      latencyMs: result.latencyMs,
      timestamp: result.timestamp,
      ...(result.error ? { error: result.error } : {}),
      ...(result.message ? { message: result.message } : {}),
    });
  }

  /**
   * Raw probe returning the same shape as the other indicators in this module.
   * Resolves with `status: 'down'` instead of rejecting on any failure.
   */
  async ping(timeoutMs: number = PrismaHealthIndicator.DEFAULT_TIMEOUT_MS): Promise<PrismaPingResult> {
    const startedAt = Date.now();
    try {
      await this.withTimeout(this.prisma.$queryRaw`SELECT 1`, timeoutMs);
      return {
        status: 'up',
        latencyMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      this.logger.error(`Prisma health check failed after ${latencyMs}ms: ${message}`);
      return {
        status: 'down',
        latencyMs,
        timestamp: new Date().toISOString(),
        error: errorName,
        message,
      };
    }
  }

  /**
   * Rejects if `probe` has not settled within `timeoutMs`. The underlying
   * query is not cancelled — Prisma's own statement/pool timeouts clean up the
   * connection — but the caller stops waiting on it.
   */
  private withTimeout<T>(probe: Promise<T>, timeoutMs: number): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return probe;
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Database health check timed out after ${timeoutMs}ms`));
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
