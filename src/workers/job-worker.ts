import type { LoggerService } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { DEFAULT_JOB_OPTIONS } from '../queues/queue.module';
import type { WorkerMetricsService } from '../modules/metrics/worker-metrics.service';
import { scrubForLog, scrubString } from '../utils/log-scrubber.util';
import { isTerminalJobFailure } from './dlq.processor';

/**
 * The subset of a BullMQ `Job` the wrapper reads. Kept structural so workers
 * can be exercised with plain objects in tests; every field but `data` is
 * optional and falls back to the queue defaults.
 */
export interface WorkerJob<TData = unknown> {
  id?: string;
  name?: string;
  data: TData;
  /** Attempts that already failed before the current one (BullMQ semantics). */
  attemptsMade?: number;
  opts?: { attempts?: number };
}

/** Lifecycle stage a worker log record describes. */
export type WorkerJobEvent = 'job.completed' | 'job.retrying' | 'job.dead-lettered';

/** One structured log line emitted by {@link runWorkerJob}. */
export interface WorkerJobLogRecord {
  event: WorkerJobEvent;
  queue: string;
  jobId?: string;
  jobName: string;
  /** 1-based number of the attempt that just ran. */
  attempt: number;
  maxAttempts: number;
  durationMs: number;
  /** True when the job was declared `UnrecoverableError` by its handler. */
  unrecoverable?: boolean;
  error?: { name: string; message: string; stack?: string };
  /** Scrubbed copy of the job payload; only attached to failure records. */
  payload?: unknown;
  trace?: Record<string, string>;
  timestamp: string;
}

export interface RunWorkerJobOptions<TData, TResult> {
  queue: string;
  job: WorkerJob<TData>;
  logger: Pick<LoggerService, 'log' | 'warn' | 'error'> & Partial<Pick<LoggerService, 'debug'>>;
  handler: () => Promise<TResult>;
  /** When provided, the handler is timed into `worker_job_*` Prometheus series. */
  metrics?: Pick<WorkerMetricsService, 'instrumentJob'>;
  /** Job name used when the BullMQ job carries none. */
  defaultJobName?: string;
}

/** Payload keys lifted into `trace` so a failure can be tied to its origin. */
const TRACE_KEYS = ['traceId', 'correlationId', 'requestId', 'organizationId', 'agentId'] as const;

/**
 * Runs a background job handler with centralized error handling and
 * structured, secret-scrubbed logging.
 *
 * Every failure is classified before it is rethrown:
 *  - **Transient** — retries remain, so a `job.retrying` warning is logged and
 *    the error propagates for BullMQ to reschedule with backoff.
 *  - **Terminal** — the final attempt failed, or the handler threw an
 *    `UnrecoverableError`. A `job.dead-lettered` error is logged carrying the
 *    scrubbed payload and stack; `QueueFailureListener` then copies the job onto
 *    the dead-letter queue when BullMQ emits `failed`.
 *
 * The original error is always rethrown untouched so BullMQ's retry and
 * `UnrecoverableError` semantics are preserved, and a logging failure can never
 * mask it.
 */
export async function runWorkerJob<TData, TResult>(
  options: RunWorkerJobOptions<TData, TResult>,
): Promise<TResult> {
  const { queue, job, logger, handler, metrics } = options;
  const jobName = job.name ?? options.defaultJobName ?? queue;
  const attempt = (job.attemptsMade ?? 0) + 1;
  const maxAttempts = job.opts?.attempts ?? DEFAULT_JOB_OPTIONS.attempts;
  const startedAt = Date.now();

  const base = () => ({
    queue,
    jobId: job.id,
    jobName,
    attempt,
    maxAttempts,
    durationMs: Date.now() - startedAt,
    trace: extractTrace(job.data),
  });

  try {
    const result = metrics ? await metrics.instrumentJob(queue, jobName, handler) : await handler();

    emit(() => {
      const record: WorkerJobLogRecord = {
        event: 'job.completed',
        ...base(),
        timestamp: new Date().toISOString(),
      };
      (logger.debug ?? logger.log).call(logger, JSON.stringify(record));
    });

    return result;
  } catch (error) {
    emit(() => {
      const described = describeError(error);
      const unrecoverable = error instanceof UnrecoverableError;
      const terminal =
        unrecoverable ||
        isTerminalJobFailure(
          { attemptsMade: attempt, opts: { attempts: maxAttempts }, stacktrace: [] },
          `${described.name}: ${described.message}`,
          maxAttempts,
        );

      const record: WorkerJobLogRecord = {
        event: terminal ? 'job.dead-lettered' : 'job.retrying',
        ...base(),
        ...(unrecoverable ? { unrecoverable: true } : {}),
        error: described,
        payload: scrubForLog(job.data),
        timestamp: new Date().toISOString(),
      };

      if (terminal) {
        logger.error(
          JSON.stringify(record),
          `Job ${job.id ?? jobName} on queue '${queue}' failed terminally on attempt ` +
            `${attempt}/${maxAttempts}; routing to dead-letter: ${described.message}`,
        );
      } else {
        logger.warn(
          JSON.stringify(record),
          `Job ${job.id ?? jobName} on queue '${queue}' failed on attempt ` +
            `${attempt}/${maxAttempts}; will retry: ${described.message}`,
        );
      }
    });

    throw error;
  }
}

/** Runs a logging side effect, swallowing anything it throws. */
function emit(write: () => void): void {
  try {
    write();
  } catch {
    // Logging is best-effort: it must never replace the job's own outcome.
  }
}

function describeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: scrubString(error.message),
      stack: error.stack ? scrubString(error.stack) : undefined,
    };
  }
  return { name: 'NonError', message: scrubString(String(error)) };
}

function extractTrace(data: unknown): Record<string, string> | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const payload = data as Record<string, unknown>;
  const metadata =
    payload.metadata && typeof payload.metadata === 'object'
      ? (payload.metadata as Record<string, unknown>)
      : {};
  const trace: Record<string, string> = {};
  for (const key of TRACE_KEYS) {
    const value = payload[key] ?? metadata[key];
    if (typeof value === 'string') trace[key] = value;
  }
  return Object.keys(trace).length ? trace : undefined;
}
