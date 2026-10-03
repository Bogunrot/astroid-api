import { Logger } from '@nestjs/common';
import { WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { DEFAULT_JOB_OPTIONS } from '../queues/queue.module';

/**
 * Determines whether a BullMQ job failure is terminal (exhausted retries or
 * marked unrecoverable) and should be captured by the dead-letter observer.
 */
export function isTerminalJobFailure(
  job: Pick<Job, 'attemptsMade' | 'opts' | 'stacktrace'>,
  failedReason?: string,
  defaultAttempts: number = DEFAULT_JOB_OPTIONS.attempts,
): boolean {
  if (isUnrecoverableFailure(failedReason, job.stacktrace)) {
    return true;
  }

  const maxAttempts = job.opts?.attempts ?? defaultAttempts;
  return (job.attemptsMade ?? 0) >= maxAttempts;
}

function isUnrecoverableFailure(failedReason?: string, stacktrace?: string[]): boolean {
  const haystack = [failedReason, ...(stacktrace ?? [])].filter(Boolean).join('\n');
  return /UnrecoverableError/i.test(haystack);
}

export class DlqProcessor extends WorkerHost {
  private readonly logger = new Logger(DlqProcessor.name);

  async process(job: Job): Promise<void> {
    this.logger.log(`Processing DLQ job ${job.id}`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
  }
}