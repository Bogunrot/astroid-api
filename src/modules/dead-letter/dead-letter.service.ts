import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, Queue, QueueEvents } from 'bullmq';
import { Queues, QueueName } from '../../queues/queues.constants';
import { redisConfig } from '../../config/redis.config';
import { PrismaService } from '../../database/prisma.service';
import { DomainEventName } from '../../events/event-names';
import { isTerminalJobFailure } from '../../workers/dlq.processor';
import type { Prisma } from '@prisma/client';

/**
 * Structured context captured whenever a BullMQ job fails terminally (i.e. the
 * retry limit was exhausted or the failure was deemed unrecoverable). This is
 * the record that is logged and persisted for audit / monitoring.
 */
export interface JobFailureContext {
  /** Named queue the job belonged to (see `@queues/*`). */
  queue: string;
  /** BullMQ job id within that queue. */
  jobId: string;
  /** Job name (BullMQ `Job#name`). */
  name?: string;
  /** The enqueued payload. Serialized defensively — may be truncated. */
  data?: unknown;
  /** Number of attempts already made before the terminal failure. */
  attemptsMade: number;
  /** Human-readable reason reported by BullMQ on the failed event. */
  failedReason?: string;
  /** Worker-level stack trace captured by BullMQ, if any. */
  stacktrace?: string[];
  /** When the failure was observed by this service. */
  failedAt: Date;
}

const DLQ_EVENT_NAMES = [
  DomainEventName.JobFailed,
  DomainEventName.JobRequeued,
  DomainEventName.JobPurged,
];

/**
 * Dead-letter queue (DLQ) ledger service.
 *
 * Subscribes to the BullMQ `failed` event on every named queue and captures
 * terminal job failures that workers gave up on (exhausted retries or
 * `UnrecoverableError`). Each failure is persisted to the append-only
 * `domain_events` DLQ ledger for audit and administrative inspection, and can
 * be safely re-driven via {@link requeue} or removed via {@link purge}.
 *
 * This is a passive observer, not a worker: it opens read-only `Queue` and
 * `QueueEvents` connections (mirroring how `MetricsService` samples queue
 * depths), so it can never crash a consuming worker or change retry semantics.
 * Every handler is fault-tolerant — a persistence failure is logged and
 * swallowed, never surfaced into the event loop.
 *
 * Note: structured *logging* of job failures (including `stalled` events) is
 * owned by `QueueFailureListener` in `@queues/queue-failure-listener`; this
 * service owns the durable record and the operator actions.
 */
@Injectable()
export class DeadLetterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeadLetterService.name);

  private readonly queueHandles: Map<string, Queue>;
  private readonly queueEvents = new Map<string, QueueEvents>();

  constructor(private readonly prisma: PrismaService) {
    this.queueHandles = this.createQueueHandles();
  }

  /** Opens read-only `Queue` handles so failures can be loaded and inspected. */
  private createQueueHandles(): Map<string, Queue> {
    const connection = this.redisConnection();
    const handles = new Map<string, Queue>();
    for (const queueName of Object.values(Queues)) {
      handles.set(queueName, new Queue(queueName, { connection }));
    }
    return handles;
  }

  /** Attaches a `failed` listener per queue to catch terminal job failures. */
  onModuleInit(): void {
    const connection = this.redisConnection();
    for (const queueName of Object.values(Queues)) {
      const events = new QueueEvents(queueName, { connection });
      events.on('failed', (args: { jobId?: string; failedReason?: string }) => {
        if (!args?.jobId) {
          this.logger.warn(`Queue ${queueName} emitted a failed event without a jobId`);
          return;
        }
        // Fire-and-forget the async handler; its own try/catch guarantees this
        // outer event callback can never reject and crash the process.
        void this.handleFailed(queueName, args.jobId, args.failedReason);
      });
      this.queueEvents.set(queueName, events);
    }
  }

  /**
   * Handles one terminal job failure: loads the full job context and persists
   * an immutable DLQ ledger entry. Never throws — a failure anywhere in the
   * pipeline is logged and swallowed so the event loop stays healthy.
   */
  async handleFailed(queue: string, jobId: string, failedReason?: string): Promise<void> {
    const context: JobFailureContext = {
      queue,
      jobId,
      name: undefined,
      data: undefined,
      attemptsMade: 0,
      failedReason,
      stacktrace: undefined,
      failedAt: new Date(),
    };

    try {
      const job = await this.loadJob(queue, jobId);
      if (job) {
        if (!isTerminalJobFailure(job, failedReason)) {
          return;
        }
        context.name = job.name;
        context.data = this.safeJson(context.data ?? job.data);
        context.attemptsMade = job.attemptsMade ?? 0;
        context.stacktrace = job.stacktrace?.length ? job.stacktrace : undefined;
      } else {
        this.logger.warn(`DLQ could not load job ${queue}/${jobId}; the job record may have been cleaned up`);
      }

      // Structured logging of the failure itself is owned by
      // `QueueFailureListener`; this service only owns the durable record.
      const organizationId = this.extractOrganizationId(context.data);
      await this.persistLedgerEntry({ organizationId, context });
    } catch (error) {
      // Never crash the queue event listener, regardless of what failed.
      this.logger.error(
        `DLQ processing failed for ${queue}/${jobId}: ${(error as Error)?.message ?? error}`,
      );
    }
  }

  /**
   * Re-drives a previously failed job back onto its queue so it can be retried
   * after an operator has remediated the underlying cause. The original failed
   * job is left intact for auditing; a new job is enqueued under a distinct id.
   */
  async requeue(queue: string, jobId: string): Promise<{ queue: string; jobId: string; requeuedJobId: string }> {
    const normalized = this.normalizeQueue(queue);
    const job = await this.loadJob(normalized, jobId);
    if (!job) {
      throw new Error(`Cannot re-drive ${normalized}/${jobId}: job not found`);
    }

    const requeuedJobId = `dlq-retry-${jobId}-${Date.now()}`;
    await this.queueHandles.get(normalized)!.add(job.name ?? 'default', job.data, {
      jobId: requeuedJobId,
      attempts: job.opts?.attempts,
      backoff: job.opts?.backoff,
    });

    this.logger.warn(`DLQ re-drive: enqueued ${normalized}/${requeuedJobId} from failed job ${jobId}`);

    await this.safePersist({
      organizationId: this.extractOrganizationId(job.data),
      name: DomainEventName.JobRequeued,
      aggregateId: jobId,
      payload: { queue: normalized, originalJobId: jobId, requeuedJobId },
    }).catch(() => undefined);

    return { queue: normalized, jobId, requeuedJobId };
  }

  /**
   * Permanently removes a failed job from Redis after operator review. The
   * purge is recorded in the append-only DLQ ledger for audit.
   */
  async purge(queue: string, jobId: string): Promise<{ queue: string; jobId: string; purged: true }> {
    const normalized = this.normalizeQueue(queue);
    const job = await this.loadJob(normalized, jobId);
    if (!job) {
      throw new Error(`Cannot purge ${normalized}/${jobId}: job not found`);
    }

    await job.remove();
    this.logger.warn(`DLQ purge: removed ${normalized}/${jobId} from Redis`);

    await this.safePersist({
      organizationId: this.extractOrganizationId(job.data),
      name: DomainEventName.JobPurged,
      aggregateId: jobId,
      payload: {
        queue: normalized,
        jobId,
        purgedAt: new Date().toISOString(),
      },
    }).catch(() => undefined);

    return { queue: normalized, jobId, purged: true };
  }

  /**
   * Lists DLQ events (terminal failures and re-drives) for an organization,
   * optionally restricted to a single queue, newest first.
   */
  listForOrganization(
    organizationId: string,
    queue?: string,
    take = 50,
  ): Promise<Array<Record<string, unknown>>> {
    const where: Prisma.DomainEventWhereInput = {
      organizationId,
      name: { in: DLQ_EVENT_NAMES as string[] },
    };
    if (queue) {
      where.payload = { path: ['queue'], equals: this.normalizeQueue(queue) };
    }
    return this.prisma.domainEvent.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
      take: Math.min(Math.max(take, 1), 200),
      select: { id: true, name: true, aggregateId: true, payload: true, occurredAt: true },
    });
  }

  /** Resolves a job from the queue's handle, tolerating missing/stale records. */
  private async loadJob(queue: string, jobId: string): Promise<Job | null> {
    const handle = this.queueHandles.get(queue);
    if (!handle) return null;
    return handle.getJob(jobId);
  }

  /** Writes the terminal failure to the append-only domain event ledger. */
  private async persistLedgerEntry(args: {
    organizationId?: string;
    context: JobFailureContext;
  }): Promise<void> {
    const { organizationId, context } = args;
    await this.safePersist({
      organizationId,
      name: DomainEventName.JobFailed,
      aggregateId: context.jobId,
      payload: {
        queue: context.queue,
        jobId: context.jobId,
        name: context.name,
        attemptsMade: context.attemptsMade,
        failedReason: context.failedReason,
        stacktrace: context.stacktrace,
        data: context.data,
        failedAt: context.failedAt.toISOString(),
      },
    });
  }

  private async safePersist(args: {
    organizationId?: string;
    name: string;
    aggregateId?: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.prisma.domainEvent.create({
        data: {
          organizationId: args.organizationId ?? null,
          name: args.name,
          aggregateType: 'dead_letter',
          aggregateId: args.aggregateId ?? null,
          payload: args.payload as Prisma.InputJsonValue,
          occurredAt: new Date(),
        },
      });
    } catch (error) {
      // Persistence must never crash the listener; log and move on.
      this.logger.error(
        `Failed to persist DLQ event '${args.name}': ${(error as Error)?.message ?? error}`,
      );
    }
  }

  private extractOrganizationId(data: unknown): string | undefined {
    if (!data || typeof data !== 'object') return undefined;
    const value = (data as Record<string, unknown>).organizationId;
    return typeof value === 'string' ? value : undefined;
  }

  /** Coerces a payload into a JSON-safe value for ledger storage. */
  private safeJson(value: unknown): unknown {
    if (value === undefined) return null;
    if (value === null || typeof value !== 'object') return value;
    try {
      return JSON.parse(
        JSON.stringify(value, (_key, v: unknown) =>
          typeof v === 'bigint' ? (v as bigint).toString() : v,
        ),
      );
    } catch {
      return String(value);
    }
  }

  private normalizeQueue(queue: string): QueueName {
    if (this.isQueueName(queue)) return queue;
    throw new Error(`Unknown BullMQ queue: ${queue}`);
  }

  private isQueueName(value: string): value is QueueName {
    return (Object.values(Queues) as string[]).includes(value);
  }

  private redisConnection(): {
    host: string;
    port: number;
    password?: string;
    db: number;
  } {
    const { host, port, password, db } = redisConfig();
    return { host, port, password: password || undefined, db };
  }

  async onModuleDestroy(): Promise<void> {
    const closables: Array<{ close(): Promise<void> }> = [
      ...Array.from(this.queueEvents.values()),
      ...Array.from(this.queueHandles.values()),
    ];
    await Promise.all(closables.map((c) => c.close().catch(() => undefined)));
  }
}