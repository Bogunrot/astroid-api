import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { redisConfig } from '../../../config/redis.config';
import { Queues } from '../../../queues/queues.constants';

export interface QueueHealthStatus {
  /** Registered BullMQ queue name. */
  queue: string;
  /** Connection status of the queue's underlying Redis client. */
  connection: 'up' | 'down';
  /** Error message when the queue could not be reached or probed timed out. */
  error?: string;
  counts: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    paused: number;
  };
}

export interface QueuesHealthReport {
  status: 'up' | 'down' | 'degraded';
  timestamp: string;
  redis: 'up' | 'down';
  queues: QueueHealthStatus[];
}

/**
 * Default timeout for probing a single queue, in milliseconds. A Redis
 * connection that drops mid-probe can hang the underlying command; the probe
 * is raced against this timeout so the health endpoint always answers before
 * a Kubernetes liveness/readiness probe deadline.
 */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * BullMQ queue health indicator.
 *
 * Inspects the core BullMQ queues (notifications, webhooks, stellar-sync,
 * analytics, reports, outbox-events, stellar-fee-bump, transactions,
 * risk-analysis, dead-letter, audit-cleanup, audit) and gathers waiting /
 * active / failed / delayed / completed / paused job counts plus Redis
 * connectivity, so Kubernetes (or any orchestrator) can monitor asynchronous
 * processing health through one JSON endpoint.
 *
 * The indicator constructs lightweight Queue handles on the shared Redis
 * connection settings and closes them after probing — it never starts
 * workers. Failures and timeouts degrade gracefully: a queue that cannot be
 * probed is reported as `down` with an error instead of throwing, and the
 * overall report status becomes `degraded` (or `down` when Redis itself is
 * unreachable).
 */
@Injectable()
export class BullMQHealthIndicator {
  private readonly logger = new Logger(BullMQHealthIndicator.name);
  private readonly queueHandles = new Map<string, Queue>();

  constructor(timeoutMs: number = PROBE_TIMEOUT_MS) {
    this.probeTimeoutMs = timeoutMs;
  }

  private readonly probeTimeoutMs: number;

  /** Queues monitored by this indicator. */
  get monitoredQueues(): string[] {
    return Object.values(Queues);
  }

  /**
   * Probes every monitored queue and assembles the overall health report.
   * Never throws — all failures are captured per queue in the report.
   */
  async checkHealth(): Promise<QueuesHealthReport> {
    const queueStatuses = await Promise.all(
      this.monitoredQueues.map((queueName) => this.probeQueue(queueName)),
    );

    // Redis is considered reachable when at least one probe succeeded — a
    // per-queue timeout with other successes indicates a queue-level issue,
    // not a Redis outage.
    const anyQueueUp = queueStatuses.some((q) => q.connection === 'up');
    const failingQueues = queueStatuses.filter((q) => q.error !== undefined).length;

    let status: QueuesHealthReport['status'] = 'up';
    if (!anyQueueUp) {
      status = 'down';
    } else if (failingQueues > 0) {
      status = 'degraded';
    }

    return {
      status,
      timestamp: new Date().toISOString(),
      redis: anyQueueUp ? 'up' : 'down',
      queues: queueStatuses,
    };
  }

  /**
   * Probes a single queue with a hard timeout. Returns a structured status
   * even when Redis is unreachable or the queue is unresponsive.
   */
  async probeQueue(queueName: string): Promise<QueueHealthStatus> {
    let queue: Queue | undefined;
    try {
      queue = this.getQueue(queueName);
      const counts = await this.withTimeout(queue.getJobCounts(
        'waiting',
        'active',
        'completed',
        'failed',
        'delayed',
        'paused',
      ));

      return {
        queue: queueName,
        connection: 'up',
        counts: {
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          completed: counts.completed ?? 0,
          failed: counts.failed ?? 0,
          delayed: counts.delayed ?? 0,
          paused: counts.paused ?? 0,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Queue health probe failed for '${queueName}': ${message}`);
      return {
        queue: queueName,
        connection: 'down',
        error: message,
        counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 },
      };
    }
  }

  /**
   * Racy timeout wrapper — resolves with the probe result or rejects when the
   * probe exceeds {@link probeTimeoutMs}. Guarantees the health endpoint
   * responds even when Redis drops mid-command.
   */
  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Queue probe timed out after ${this.probeTimeoutMs}ms`)),
        this.probeTimeoutMs,
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  /**
   * Lazily creates (or returns a previously created test-injected) queue
   * handle. In tests the handles map may be pre-populated with mocks.
   */
  protected getQueue(queueName: string): Queue {
    return this.queueHandles.get(queueName) ?? this.createQueue(queueName);
  }

  /** Registers (replaces) the handle used for a queue — used by tests. */
  setQueueHandle(queueName: string, queue: Queue): void {
    const existing = this.queueHandles.get(queueName);
    if (existing && existing !== queue) {
      void existing.close().catch(() => undefined);
    }
    this.queueHandles.set(queueName, queue);
  }

  private createQueue(queueName: string): Queue {
    const { host, port, password, db } = redisConfig();
    const queue = new Queue(queueName, {
      connection: { host, port, password: password || undefined, db },
    });
    this.queueHandles.set(queueName, queue);
    return queue;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      Array.from(this.queueHandles.values()).map((queue) =>
        queue.close().catch(() => undefined),
      ),
    );
  }
}
