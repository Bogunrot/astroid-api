import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { Queues, DlqJobData } from './queues.constants';
import { PrismaService } from '../database/prisma.service';
import { retryWithBackoff } from '../utils/retry.util';

/**
 * BullMQ worker processor for the Dead-Letter Queue (DLQ).
 *
 * Jobs that exhaust maximum retry attempts across transaction execution,
 * webhook delivery, risk analysis, and other background workers are routed here
 * for logging, alerting, forensic auditing, and administrative triage.
 */
@Injectable()
@Processor(Queues.DeadLetter)
export class DlqProcessor extends WorkerHost {
  private readonly logger = new Logger(DlqProcessor.name);

  constructor(@Optional() @Inject(PrismaService) private readonly prisma?: PrismaService) {
    super();
  }

  /**
   * Processes a dead-lettered job.
   * Logs full error diagnostics, failure reasons, and stack traces.
   */
  async process(job: Job<DlqJobData>): Promise<{ handled: boolean; deadLetteredAt: string }> {
    const {
      originalQueue,
      originalJobId,
      originalJobName,
      payload,
      failedReason,
      stacktrace,
      attemptsMade,
      failedAt,
    } = job.data;

    this.logger.error(
      `[DLQ-JOB-RECEIVED] Job ${originalJobId ?? job.id} from queue '${originalQueue}' (${originalJobName ?? 'unknown'}) permanently failed after ${attemptsMade} attempts. Reason: ${failedReason ?? 'Unknown'}`,
    );

    this.logger.debug(
      `[DLQ-JOB-DETAILS] Payload: ${JSON.stringify(payload)} | Stacktrace: ${JSON.stringify(stacktrace ?? [])} | FailedAt: ${failedAt}`,
    );

    await this.recordDeadLetterAudit(job.data);

    return {
      handled: true,
      deadLetteredAt: failedAt || new Date().toISOString(),
    };
  }

  /**
   * Helper method to route a failed job from any queue into the DLQ.
   *
   * @param dlqQueue BullMQ Queue instance for the dead-letter queue
   * @param failedJob Original failed job
   * @param error Error that caused the failure
   * @param originalQueue Name of the queue where failure occurred
   */
  static async moveToDeadLetter(
    dlqQueue: Queue<DlqJobData>,
    failedJob: Job,
    error: Error | string,
    originalQueue: string,
  ): Promise<Job<DlqJobData>> {
    const failedReason = typeof error === 'string' ? error : error.message;
    const stacktrace = typeof error === 'object' && error.stack ? [error.stack] : failedJob.stacktrace;

    const dlqData: DlqJobData = {
      originalQueue,
      originalJobId: failedJob.id,
      originalJobName: failedJob.name,
      payload: failedJob.data,
      failedReason,
      stacktrace: stacktrace ?? [],
      attemptsMade: failedJob.attemptsMade,
      failedAt: new Date().toISOString(),
      metadata: {
        timestamp: failedJob.timestamp,
        processedOn: failedJob.processedOn,
        finishedOn: failedJob.finishedOn,
      },
    };

    return dlqQueue.add(`dlq:${originalQueue}:${failedJob.id ?? Date.now()}`, dlqData, {
      removeOnComplete: { count: 5000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    });
  }

  /**
   * Records a domain event or audit log for dead-lettered jobs if database is available.
   * Retries up to three times on transient errors; stops immediately on constraint
   * violations that would not succeed on a retry.
   */
  private async recordDeadLetterAudit(data: DlqJobData): Promise<void> {
    if (!this.prisma) return;

    try {
      const client = this.prisma.workerClient ?? this.prisma;
      const prismaAny = client as unknown as Record<string, unknown>;
      const domainEvents = prismaAny['domainEvent'] as
        | { create?: (args: unknown) => Promise<unknown> }
        | undefined;

      if (domainEvents?.create) {
        await retryWithBackoff(
          () =>
            domainEvents.create!({
              data: {
                name: 'job.dead_lettered',
                aggregateType: 'DEAD_LETTER_QUEUE',
                aggregateId: data.originalJobId ?? null,
                payload: {
                  originalQueue: data.originalQueue,
                  originalJobName: data.originalJobName,
                  failedReason: data.failedReason,
                  stacktrace: data.stacktrace ?? [],
                  payload: data.payload,
                  attemptsMade: data.attemptsMade,
                  failedAt: data.failedAt,
                },
              },
            }),
          {
            maxAttempts: 3,
            baseDelayMs: 200,
            operationName: 'DLQ audit event',
            isRetryable: (err: unknown) =>
              !(err instanceof Error && err.message.includes('NOT NULL')),
          },
        );
      }
    } catch (err) {
      this.logger.error(`Failed to record DLQ audit event after retries: ${(err as Error).message}`);
    }
  }
}
