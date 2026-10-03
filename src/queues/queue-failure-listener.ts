import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, Queue, QueueEvents } from 'bullmq';
import { Queues, DlqJobData } from './queues.constants';
import { redisConfig } from '../config/redis.config';
import { isTerminalJobFailure } from '../workers/dlq.processor';
import { RequestContext } from '../common/context/request-context';
import { scrubForLog, scrubString } from '../utils/log-scrubber.util';

/** Correlation identifiers recovered from the job payload, when present. */
export interface JobTraceContext {
  traceId?: string;
  correlationId?: string;
  requestId?: string;
  organizationId?: string;
  agentId?: string;
}

/** Every field a single failure log line carries, in one structured record. */
export interface JobFailureRecord {
  /** Which BullMQ event produced this record. */
  event: 'failed' | 'stalled';
  queue: string;
  jobId: string;
  jobName?: string;
  /** Attempts consumed so far (0 for a `stalled` event, which BullMQ does not report). */
  attemptsMade: number;
  /** Retry ceiling for the job, when BullMQ reported one. */
  maxAttempts?: number;
  failedReason?: string;
  stacktrace?: string[];
  /** The enqueued payload, serialized defensively. */
  payload?: unknown;
  /** True when retries were exhausted or the failure was unrecoverable. */
  terminal: boolean;
  observedAt: string;
  trace: JobTraceContext;
}

/** Shape BullMQ emits for the `failed` queue event. */
export interface QueueFailedEvent {
  jobId?: string;
  failedReason?: string;
  prev?: string;
}

/** Shape BullMQ emits for the `stalled` queue event. */
export interface QueueStalledEvent {
  jobId?: string;
  prev?: string;
}

/**
 * Global BullMQ failure observer.
 *
 * Attaches a read-only `QueueEvents` listener to every queue named in
 * {@link Queues} and turns each `failed` / `stalled` event into one structured
 * log record, then routes terminal failures onto the dead-letter queue so they
 * show up for administrative review. This is the single owner of failure
 * *logging* for background jobs — `DeadLetterService` owns the durable ledger
 * and the operator re-drive/purge actions.
 *
 * Design constraints this service deliberately honours:
 *  - **Never blocks a worker.** Handlers are fire-and-forget and every one of
 *    them is wrapped in `try/catch`, so neither a Redis hiccup nor a logging
 *    failure can reject into the event loop and take the worker process down.
 *  - **Read-only observation.** Only the dead-letter queue is ever written to;
 *    the source job is left exactly as BullMQ recorded it, so retry semantics
 *    and the `failed` set are untouched.
 *  - **Correlated.** Trace identifiers are recovered from the job payload (and
 *    the ambient {@link RequestContext} when the job is processed inside a
 *    request), so a log line can be tied back to the API call that enqueued it.
 *  - **No loops.** Failures originating from the dead-letter queue itself are
 *    logged but never re-routed.
 */
@Injectable()
export class QueueFailureListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueFailureListener.name);

  private readonly queueEvents = new Map<string, QueueEvents>();
  private readonly queueHandles = new Map<string, Queue>();

  onModuleInit(): void {
    const connection = this.redisConnection();
    for (const queueName of Object.values(Queues)) {
      const events = new QueueEvents(queueName, { connection });
      events.on('failed', (args: QueueFailedEvent) => {
        this.safeDispatch(() => this.handleFailed(queueName, args));
      });
      events.on('stalled', (args: QueueStalledEvent) => {
        this.safeDispatch(() => this.handleStalled(queueName, args));
      });
      this.queueEvents.set(queueName, events);
    }
  }

  /**
   * Records a `failed` event: enriches it with the stored job, logs it, and
   * dead-letters it once retries are exhausted. Never throws.
   */
  async handleFailed(queue: string, args: QueueFailedEvent): Promise<JobFailureRecord | null> {
    const jobId = args?.jobId;
    if (!jobId) {
      this.logger.warn(
        JSON.stringify({
          event: 'failed',
          queue,
          reason: 'missing-job-id',
          observedAt: new Date().toISOString(),
        }),
      );
      return null;
    }

    const record = await this.buildRecord('failed', queue, jobId, args?.failedReason);

    if (record.terminal && queue !== Queues.DeadLetter) {
      // Route for administrative review; a failure here must not mask the
      // original problem, so it is reported and swallowed.
      await this.routeToDeadLetter(record);
    }

    return record;
  }

  /**
   * Records a `stalled` event — a job whose lock expired and that BullMQ will
   * reprocess. Stalled jobs have not necessarily failed, so they are logged as
   * warnings and never dead-lettered. Never throws.
   */
  async handleStalled(queue: string, args: QueueStalledEvent): Promise<JobFailureRecord | null> {
    const jobId = args?.jobId;
    if (!jobId) {
      this.logger.warn(
        JSON.stringify({
          event: 'stalled',
          queue,
          reason: 'missing-job-id',
          observedAt: new Date().toISOString(),
        }),
      );
      return null;
    }

    return this.buildRecord('stalled', queue, jobId, undefined);
  }

  /** Number of queues currently being observed (used by tests and diagnostics). */
  get observedQueueCount(): number {
    return this.queueEvents.size;
  }

  private async buildRecord(
    event: 'failed' | 'stalled',
    queue: string,
    jobId: string,
    failedReason: string | undefined,
  ): Promise<JobFailureRecord> {
    const job = await this.loadJob(queue, jobId);
    const maxAttempts = job?.opts?.attempts;
    const attemptsMade = event === 'failed' ? (job?.attemptsMade ?? 0) : 0;

    const record: JobFailureRecord = {
      event,
      queue,
      jobId,
      jobName: job?.name,
      attemptsMade,
      maxAttempts,
      failedReason,
      stacktrace: job?.stacktrace?.length ? job.stacktrace : undefined,
      payload: this.safeJson(job?.data),
      // A failure is only terminal once we can see the job's retry state; if
      // the record was already cleaned up we cannot claim it exhausted retries.
      terminal: event === 'failed' && job !== null && isTerminalJobFailure(job, failedReason),
      observedAt: new Date().toISOString(),
      trace: this.extractTrace(job?.data),
    };

    this.logRecord(record);
    return record;
  }

  private logRecord(record: JobFailureRecord): void {
    // Only the log line is scrubbed; the dead-letter copy keeps the raw payload
    // so an operator re-drive replays the job exactly as it was enqueued.
    const line = JSON.stringify({
      ...record,
      failedReason: record.failedReason && scrubString(record.failedReason),
      stacktrace: record.stacktrace?.map(scrubString),
      payload: scrubForLog(record.payload),
    });
    if (record.event === 'stalled') {
      this.logger.warn(
        line,
        `Job stalled on queue '${record.queue}' (job ${record.jobId}); it will be reprocessed`,
      );
      return;
    }
    this.logger.error(
      line,
      record.terminal
        ? `Job ${record.jobId} on queue '${record.queue}' failed terminally after ${record.attemptsMade} attempts: ${record.failedReason ?? 'unknown reason'}`
        : `Job ${record.jobId} on queue '${record.queue}' failed (attempt ${record.attemptsMade}/${record.maxAttempts ?? '?'}): ${record.failedReason ?? 'unknown reason'}`,
    );
  }

  /**
   * Enqueues a copy of the terminal failure on the dead-letter queue for
   * administrative triage. Failures are logged, never propagated.
   */
  private async routeToDeadLetter(record: JobFailureRecord): Promise<void> {
    try {
      const queue = this.getHandle(Queues.DeadLetter) as Queue<DlqJobData>;

      const data: DlqJobData = {
        originalQueue: record.queue,
        originalJobId: record.jobId,
        originalJobName: record.jobName,
        payload: record.payload ?? null,
        failedReason: record.failedReason,
        stacktrace: record.stacktrace ?? [],
        attemptsMade: record.attemptsMade,
        failedAt: record.observedAt,
        metadata: {
          maxAttempts: record.maxAttempts,
          traceId: record.trace.traceId,
          correlationId: record.trace.correlationId,
          requestId: record.trace.requestId,
          organizationId: record.trace.organizationId,
          agentId: record.trace.agentId,
        },
      };

      await queue.add(`dlq:${record.queue}:${record.jobId}`, data, {
        removeOnComplete: { count: 5_000 },
        removeOnFail: { age: 7 * 24 * 3_600 },
      });
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'dead-letter-route-failed',
          queue: record.queue,
          jobId: record.jobId,
          error: this.describe(error),
          observedAt: record.observedAt,
        }),
      );
    }
  }

  /**
   * Cached per-queue handle used to read job documents, so a burst of failures
   * reuses connections instead of opening one per event. Opened lazily so the
   * service still works when a failure is observed before `onModuleInit` runs.
   */
  private getHandle(queue: string): Queue {
    let handle = this.queueHandles.get(queue);
    if (!handle) {
      handle = new Queue(queue, { connection: this.redisConnection() });
      this.queueHandles.set(queue, handle);
    }
    return handle;
  }

  /**
   * Recovers correlation identifiers from the job payload, falling back to the
   * ambient request context when the failure is observed inside a request.
   */
  private extractTrace(data: unknown): JobTraceContext {
    const payload = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    const metadata =
      payload.metadata && typeof payload.metadata === 'object'
        ? (payload.metadata as Record<string, unknown>)
        : {};
    const read = (key: string): string | undefined => {
      const value = payload[key] ?? metadata[key];
      return typeof value === 'string' ? value : undefined;
    };

    const trace: JobTraceContext = {
      traceId: read('traceId') ?? RequestContext.getTraceId(),
      correlationId: read('correlationId') ?? RequestContext.getCorrelationId(),
      requestId: read('requestId') ?? RequestContext.getRequestId(),
      organizationId: read('organizationId') ?? RequestContext.getOrganizationId(),
      agentId: read('agentId') ?? RequestContext.getAgentId(),
    };

    // Drop undefined keys so the log record stays compact.
    for (const key of Object.keys(trace) as Array<keyof JobTraceContext>) {
      if (trace[key] === undefined) delete trace[key];
    }
    return trace;
  }

  /** Loads the stored job, tolerating a job that has already been cleaned up. */
  private async loadJob(queue: string, jobId: string): Promise<Job | null> {
    try {
      return await this.getHandle(queue).getJob(jobId);
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'job-lookup-failed',
          queue,
          jobId,
          error: this.describe(error),
        }),
      );
      return null;
    }
  }

  /** Fire-and-forget guard so a rejected handler can never reach the event loop. */
  private safeDispatch(work: () => Promise<unknown>): void {
    void Promise.resolve()
      .then(work)
      .catch((error: unknown) => {
        this.logger.error(
          JSON.stringify({
            event: 'listener-error',
            error: this.describe(error),
            observedAt: new Date().toISOString(),
          }),
        );
      });
  }

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

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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
      ...this.queueEvents.values(),
      ...this.queueHandles.values(),
    ];
    this.queueEvents.clear();
    this.queueHandles.clear();
    await Promise.all(closables.map((c) => c.close().catch(() => undefined)));
  }
}
