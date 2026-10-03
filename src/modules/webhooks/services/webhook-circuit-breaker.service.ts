import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { redisConfig } from '../../../config/redis.config';

/** How long a tripped (OPEN) circuit stays open before half-opening, ms. */
const DEFAULT_OPEN_STATE_TTL_MS = 60_000;

/** Consecutive failures required to trip the circuit for one domain. */
export const DEFAULT_FAILURE_THRESHOLD = 5;

/** Consecutive successes (while HALF_OPEN) required to close the circuit again. */
const RECOVERY_SUCCESS_THRESHOLD = 2;

/** Circuit states tracked per webhook endpoint domain. */
export enum WebhookCircuitState {
  /** Deliveries flow through normally; failures are counted. */
  CLOSED = 'CLOSED',
  /** Deliveries to this domain fail fast until the open-state TTL elapses. */
  OPEN = 'OPEN',
  /** Trial deliveries are allowed to probe whether the endpoint recovered. */
  HALF_OPEN = 'HALF_OPEN',
}

export interface WebhookCircuitReport {
  host: string;
  state: WebhookCircuitState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  openedAt: number | null;
  remainingOpenMs: number;
}

interface DomainBreakerSnapshot {
  failures: number;
  successes: number;
  state: WebhookCircuitState;
  openedAt: number | null;
}

/**
 * Per-domain circuit breaker for outbound webhook deliveries.
 *
 * When one subscriber endpoint starts failing (transient outage, 5xx storm),
 * the BullMQ webhook processor would otherwise keep hammering it with retries
 * from every queued job — compounding the downstream failure and wasting
 * worker concurrency. This service tracks consecutive failures keyed by the
 * endpoint's host and "trips" the circuit once a threshold is exceeded,
 * pausing deliveries to that domain only.
 *
 * State is stored in Redis so all worker replicas share one view per domain
 * (with atomic INCR/GET/TTL semantics and automatic expiry of the OPEN
 * window); when Redis is unavailable the service degrades to per-process
 * in-memory tracking so circuit protection never disappears entirely.
 *
 * Recovery follows the classic three-state machine:
 *   CLOSED → (N consecutive failures) → OPEN → (TTL elapsed) → HALF_OPEN →
 *   (M consecutive successes) → CLOSED. A failure while HALF_OPEN reopens.
 */
@Injectable()
export class WebhookCircuitBreakerService {
  private readonly logger = new Logger(WebhookCircuitBreakerService.name);
  private readonly redis: Redis | null;
  private readonly failureThreshold: number;
  private readonly openStateTtlMs: number;

  /** In-memory fallback state, keyed by host, when Redis is unavailable. */
  private readonly memoryState = new Map<string, DomainBreakerSnapshot>();

  constructor(failureThreshold: number = DEFAULT_FAILURE_THRESHOLD, openStateTtlMs: number = DEFAULT_OPEN_STATE_TTL_MS) {
    this.failureThreshold = failureThreshold;
    this.openStateTtlMs = openStateTtlMs;

    // Redis is optional: without it the breaker still works per-process.
    try {
      const { host, port, password, db } = redisConfig();
      this.redis = new Redis({
        host,
        port,
        password: password || undefined,
        db,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy: (times: number) => (times > 2 ? null : Math.min(times * 200, 1_000)),
        enableOfflineQueue: false,
      });
      this.redis.connect().catch((err: Error) => {
        this.logger.warn(`Webhook circuit breaker Redis unavailable, using in-memory state: ${err.message}`);
      });
      this.redis.on('error', () => {
        /* Logged once via connect() catch; keep the breaker silent afterwards. */
      });
    } catch {
      this.logger.warn('Redis not configured — webhook circuit breaker using in-memory state');
      this.redis = null;
    }
  }

  /**
   * Determines whether a delivery to the given URL is allowed right now.
   *
   * - CLOSED: allowed.
   * - OPEN within the TTL: blocked (fail fast — the processor short-circuits
   *   and lets BullMQ retry later, when the breaker may have half-opened).
   * - OPEN past the TTL: transitions to HALF_OPEN and allows one trial.
   * - HALF_OPEN: a trial delivery is allowed.
   */
  async isDeliveryAllowed(url: string): Promise<boolean> {
    const host = this.extractHost(url);
    const snap = await this.loadSnapshot(host);

    if (snap.state === WebhookCircuitState.OPEN) {
      const elapsed = snap.openedAt !== null ? Date.now() - snap.openedAt : this.openStateTtlMs;
      if (elapsed < this.openStateTtlMs) {
        return false;
      }
      // Stale OPEN state (TTL elapsed) — move to HALF_OPEN for a trial call.
      await this.saveSnapshot(host, {
        ...snap,
        state: WebhookCircuitState.HALF_OPEN,
        successes: 0,
      });
      this.logger.log(`Circuit for ${host} half-opened; allowing trial delivery`);
      return true;
    }

    return true;
  }

  /**
   * Records a successful delivery against the endpoint's domain.
   * While HALF_OPEN, enough consecutive successes close the circuit again.
   */
  async recordSuccess(url: string): Promise<void> {
    const host = this.extractHost(url);
    const snap = await this.loadSnapshot(host);

    if (snap.state === WebhookCircuitState.CLOSED && snap.failures === 0) {
      return; // Nothing to reset — avoid a redundant write.
    }

    if (snap.state === WebhookCircuitState.HALF_OPEN) {
      const successes = snap.successes + 1;
      if (successes >= RECOVERY_SUCCESS_THRESHOLD) {
        this.logger.log(`Circuit for ${host} closed again after recovery`);
        await this.saveSnapshot(host, {
          failures: 0,
          successes: 0,
          state: WebhookCircuitState.CLOSED,
          openedAt: null,
        });
        return;
      }
      await this.saveSnapshot(host, { ...snap, successes });
      return;
    }

    // CLOSED: a success resets the consecutive failure counter.
    await this.saveSnapshot(host, { ...snap, failures: 0 });
  }

  /**
   * Records a failed delivery against the endpoint's domain.
   * Trips the circuit OPEN when consecutive failures reach the threshold.
   */
  async recordFailure(url: string, error?: unknown): Promise<void> {
    const host = this.extractHost(url);
    const snap = await this.loadSnapshot(host);

    const failures =
      snap.state === WebhookCircuitState.HALF_OPEN
        ? this.failureThreshold // A failed trial immediately reopens.
        : snap.failures + 1;

    if (failures >= this.failureThreshold && snap.state !== WebhookCircuitState.OPEN) {
      this.logger.warn(
        `Circuit for ${host} OPEN after ${failures} consecutive failures` +
          `${error ? `: ${(error as Error)?.message ?? String(error)}` : ''}`,
      );
      await this.saveSnapshot(host, {
        failures,
        successes: 0,
        state: WebhookCircuitState.OPEN,
        openedAt: Date.now(),
      });
      return;
    }

    await this.saveSnapshot(host, { ...snap, failures, successes: 0 });
  }

  /** Force-closes the circuit for a domain (administrative override / tests). */
  async reset(url: string): Promise<void> {
    const host = this.extractHost(url);
    await this.saveSnapshot(host, {
      failures: 0,
      successes: 0,
      state: WebhookCircuitState.CLOSED,
      openedAt: null,
    });
  }

  /** Returns the current circuit report for a URL's host (observability). */
  async getReport(url: string): Promise<WebhookCircuitReport> {
    const host = this.extractHost(url);
    const snap = await this.loadSnapshot(host);
    const remainingOpenMs =
      snap.state === WebhookCircuitState.OPEN && snap.openedAt !== null
        ? Math.max(this.openStateTtlMs - (Date.now() - snap.openedAt), 0)
        : 0;

    return {
      host,
      state: snap.state,
      consecutiveFailures: snap.failures,
      consecutiveSuccesses: snap.successes,
      openedAt: snap.openedAt,
      remainingOpenMs,
    };
  }

  /** Reports for every domain the breaker currently tracks. */
  async getAllReports(): Promise<WebhookCircuitReport[]> {
    if (this.redis && this.redis.status === 'ready') {
      try {
        const keys = await this.redis.keys(`${this.keyPrefix()}*`);
        const reports: WebhookCircuitReport[] = [];
        for (const key of keys) {
          const host = key.slice(this.keyPrefix().length);
          const raw = await this.redis.get(key);
          if (!raw) continue;
          const snap = JSON.parse(raw) as DomainBreakerSnapshot;
          reports.push({
            host,
            state: snap.state,
            consecutiveFailures: snap.failures,
            consecutiveSuccesses: snap.successes,
            openedAt: snap.openedAt,
            remainingOpenMs:
              snap.state === WebhookCircuitState.OPEN && snap.openedAt !== null
                ? Math.max(this.openStateTtlMs - (Date.now() - snap.openedAt), 0)
                : 0,
          });
        }
        return reports;
      } catch {
        /* fall through to memory */
      }
    }
    return Array.from(this.memoryState.entries()).map(([host, snap]) => ({
      host,
      state: snap.state,
      consecutiveFailures: snap.failures,
      consecutiveSuccesses: snap.successes,
      openedAt: snap.openedAt,
      remainingOpenMs:
        snap.state === WebhookCircuitState.OPEN && snap.openedAt !== null
          ? Math.max(this.openStateTtlMs - (Date.now() - snap.openedAt), 0)
          : 0,
    }));
  }

  onModuleDestroy(): void {
    this.redis?.disconnect();
  }

  /** Strips the scheme, path and port-independence: tracks by hostname only. */
  private extractHost(url: string): string {
    try {
      const parsed = new URL(url);
      // Include the port so distinct services on one host don't share a fuse,
      // but normalize the default ports so http(s)://host traffic matches.
      return parsed.port && parsed.port !== '80' && parsed.port !== '443'
        ? `${parsed.hostname}:${parsed.port}`
        : parsed.hostname;
    } catch {
      // Malformed URLs still get a stable (if coarse) key.
      return 'unknown';
    }
  }

  private keyPrefix(): string {
    return 'webhook:circuit:';
  }

  private stateKey(host: string): string {
    return `${this.keyPrefix()}${host}`;
  }

  private async loadSnapshot(host: string): Promise<DomainBreakerSnapshot> {
    if (this.redis && this.redis.status === 'ready') {
      try {
        const raw = await this.redis.get(this.stateKey(host));
        if (raw) {
          const parsed = JSON.parse(raw) as DomainBreakerSnapshot;
          // Guard against stale/foreign shapes in Redis.
          if (typeof parsed?.failures === 'number' && parsed?.state) {
            return parsed;
          }
        }
        return this.emptySnapshot();
      } catch {
        /* fall through to memory */
      }
    }
    return this.memoryState.get(host) ?? this.emptySnapshot();
  }

  private async saveSnapshot(host: string, snap: DomainBreakerSnapshot): Promise<void> {
    if (this.redis && this.redis.status === 'ready') {
      try {
        // Expire slightly after the OPEN window so stale states self-clean;
        // CLOSED snapshots keep a short TTL to bound memory usage.
        const ttlSeconds =
          snap.state === WebhookCircuitState.OPEN
            ? Math.ceil(this.openStateTtlMs / 1_000) + 30
            : 300;
        await this.redis.set(this.stateKey(host), JSON.stringify(snap), 'EX', ttlSeconds);
        return;
      } catch {
        /* fall through to memory */
      }
    }
    this.memoryState.set(host, snap);
  }

  private emptySnapshot(): DomainBreakerSnapshot {
    return {
      failures: 0,
      successes: 0,
      state: WebhookCircuitState.CLOSED,
      openedAt: null,
    };
  }
}
