import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BalanceWorker } from './balance.worker';
import { AnalyticsAggregationWorker } from './analytics-aggregation.worker';
import { NotificationDeliveryWorker } from './notification-delivery.worker';
import { AuditWorker } from './audit.worker';
import { WalletModule } from '../modules/wallets/wallet.module';
import { MetricsModule } from '../modules/metrics/metrics.module';
import { AuditModule } from '../modules/audit/audit.module';
import { Queues } from '../queues/queues.constants';

/**
 * Background job processors.
 *
 * Each worker owns one queue (see `@queues/*`) and isolates failures through
 * BullMQ retry + backoff so a flaky third-party (SMTP, Slack, webhook
 * consumer) never rolls back a financial action. Register workers here; they
 * are activated by the queue module once Redis is available.
 *
 * Workers inject `WorkerMetricsService` from the MetricsModule to record
 * processing latency and outcomes against the Prometheus registry. This is
 * completely optional — workers that don't inject it simply won't emit
 * `worker_job_duration_seconds` or `worker_jobs_total` metrics.
 */
@Module({
  imports: [
    WalletModule,
    MetricsModule,
    AuditModule,
    // The audit worker consumes the dedicated `audit` queue; register it here
    // so BullMQ provisions the queue with bounded retries and exponential
    // backoff for transient database outages.
    BullModule.registerQueue({
      name: Queues.Audit,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { age: 7 * 24 * 3_600 },
      },
    }),
  ],
  providers: [
    NotificationDeliveryWorker,
    BalanceWorker,
    AnalyticsAggregationWorker,
    AuditWorker,
  ],
  exports: [
    NotificationDeliveryWorker,
    BalanceWorker,
    AnalyticsAggregationWorker,
    AuditWorker,
  ],
})
export class WorkersModule {}
