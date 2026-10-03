import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, Optional } from '@nestjs/common';
import { Job } from 'bullmq';
import { Queues } from '../queues/queues.constants';
import { AuditJobData } from '../queues/queues.constants';
import { PrismaService } from '../database/prisma.service';
import { WorkerMetricsService } from '../modules/metrics/worker-metrics.service';
import { AuditHashService } from '../modules/audit/audit-hash.service';

/**
 * How many consecutive audit-entry batches may fail to persist before the
 * worker starts logging at `error` level with a `AUDIT_PERSISTENCE_DEGRADED`
 * marker. The worker never crashes on persistence failures — audit entries are
 * best-effort for the originating request by design (see `AuditListener`) —
 * but operators need a loud signal when the audit trail is silently dropping
 * writes.
 */
const DEGRADED_FAILURE_THRESHOLD = 5;

/**
 * BullMQ worker that asynchronously persists audit log entries.
 *
 * High-frequency events (policy checks, authentication attempts, risk
 * evaluations) are enqueued by the audit module instead of being written
 * synchronously during the request-response cycle. This worker drains the
 * queue and writes the entries to PostgreSQL through Prisma:
 *
 * - Batching: every job carries a batch of entries (`AuditJobData`) which is
 *   persisted with a single bulk insert inside one transaction, so queue
 *   volume spikes translate to fewer, larger database round-trips.
 * - Hash chaining: entries are chained to the preceding audit hash per
 *   organization via {@link AuditHashService} to preserve the tamper-evident
 *   audit history produced by the synchronous `AuditService.record` path.
 * - Retries: transient database outages are retried by BullMQ with
 *   exponential backoff (see the queue registration in `AuditModule`); the
 *   failure is rethrown so BullMQ tracks attempt counts.
 * - Fail-safe: persistence errors are caught and logged — the worker process
 *   itself never crashes. On the final attempt the error is rethrown so the
 *   job lands in the dead-letter queue for forensic triage.
 */
@Processor(Queues.Audit)
export class AuditWorker extends WorkerHost {
  private readonly logger = new Logger(AuditWorker.name);

  /** Consecutive failed batches — used for the degraded-persistence signal. */
  private consecutiveFailures = 0;

  constructor(
    @Optional() @Inject(PrismaService) private readonly prisma?: PrismaService,
    @Optional() private readonly auditHashService?: AuditHashService,
    @Optional() private readonly workerMetrics?: WorkerMetricsService,
  ) {
    super();
  }

  async process(job: Job<AuditJobData>): Promise<{ persisted: number }> {
    const jobName = job.name ?? 'audit-persist';
    const execute = async (): Promise<{ persisted: number }> => {
      const entries = job.data?.entries ?? [];
      if (entries.length === 0) {
        return { persisted: 0 };
      }

      try {
        const persisted = await this.persistBatch(entries);
        this.consecutiveFailures = 0;
        this.logger.debug(`Persisted ${persisted} audit entr(ies) from job ${String(job.id)}`);
        return { persisted };
      } catch (error) {
        this.consecutiveFailures += 1;
        const message = (error as Error).message;

        if (this.consecutiveFailures >= DEGRADED_FAILURE_THRESHOLD) {
          this.logger.error(
            `[AUDIT_PERSISTENCE_DEGRADED] ${this.consecutiveFailures} consecutive failed batches — ` +
              `audit entries are being dropped: ${message}`,
          );
        } else {
          this.logger.warn(
            `Failed to persist ${entries.length} audit entr(ies) ` +
              `(attempt ${job.attemptsMade + 1}/${job.opts.attempts ?? '?'}): ${message}`,
          );
        }

        // Rethrow so BullMQ records the failure, applies backoff and — on the
        // final attempt — routes the job to the dead-letter queue.
        throw error instanceof Error ? error : new Error(message);
      }
    };

    if (this.workerMetrics) {
      return this.workerMetrics.instrumentJob(Queues.Audit, jobName, execute);
    }
    return execute();
  }

  /**
   * Persists a batch of audit entries inside a single transaction.
   *
   * Each entry is hash-chained to the previous entry of its organization so
   * the asynchronous trail stays verifiable by `AuditHashService`. Returns the
   * number of rows written.
   */
  private async persistBatch(entries: AuditJobData['entries']): Promise<number> {
    if (!this.prisma) {
      this.logger.warn('PrismaService unavailable — dropping audit batch');
      return 0;
    }

    // Persist through the dedicated worker client so bulk audit writes are
    // never aborted by the API-oriented query timeouts (issue #76).
    const client = this.prisma.workerClient ?? this.prisma;

    return client.$transaction(async (tx) => {
      let persisted = 0;
      // previousHash per organization, chained within the batch too.
      const previousHashes = new Map<string, string | null>();

      for (const entry of entries) {
        let previousHash = previousHashes.get(entry.organizationId);
        if (previousHash === undefined && this.auditHashService) {
          previousHash = await this.auditHashService.getLatestHash(entry.organizationId);
        }

        let hash: string | null = null;
        if (this.auditHashService) {
          const createdAt = new Date();
          const result = this.auditHashService.computeEntryHash(
            {
              organizationId: entry.organizationId,
              userId: entry.userId ?? null,
              action: entry.action,
              entity: entry.entity,
              entityId: entry.entityId ?? null,
              oldValue: entry.oldValue,
              newValue: entry.newValue,
              ipAddress: entry.ipAddress ?? null,
              device: entry.device ?? null,
              createdAt,
            },
            previousHash ?? null,
          );
          hash = result.hash;
          previousHashes.set(entry.organizationId, result.hash);
        }

        await tx.auditLog.create({
          data: {
            organizationId: entry.organizationId,
            userId: entry.userId ?? null,
            action: entry.action,
            entity: entry.entity,
            entityId: entry.entityId ?? null,
            oldValue: (entry.oldValue ?? undefined) as never,
            newValue: (entry.newValue ?? undefined) as never,
            ipAddress: entry.ipAddress ?? null,
            device: entry.device ?? null,
            requestId: entry.requestId ?? null,
            previousHash: previousHash ?? null,
            hash,
          },
        });
        persisted += 1;
      }

      return persisted;
    });
  }
}
