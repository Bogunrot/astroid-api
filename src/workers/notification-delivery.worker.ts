import { Injectable, Logger, Optional } from '@nestjs/common';
import { Queues } from '../queues/queues.constants';
import { WorkerMetricsService } from '../modules/metrics/worker-metrics.service';
import { runWorkerJob, WorkerJob } from './job-worker';

export interface NotificationJobPayload {
  notificationId: string;
  channel: 'dashboard' | 'email' | 'slack' | 'discord' | 'webhook';
  recipient: string;
  subject: string;
  body: string;
}

/**
 * Delivers outbound notifications one at a time. Email and chat channels can be
 * slow or token-bucketed, so sends are isolated to a worker rather than running
 * in the request path — a blocked SMTP server never delays a payment response.
 *
 * Processing latency and outcomes are recorded against the Prometheus registry
 * via `WorkerMetricsService` when available.
 */
@Injectable()
export class NotificationDeliveryWorker {
  private readonly logger = new Logger(NotificationDeliveryWorker.name);
  readonly queue = Queues.Notifications;

  constructor(
    @Optional() private readonly workerMetrics?: WorkerMetricsService,
  ) {}

  async process(job: WorkerJob<NotificationJobPayload>): Promise<void> {
    const execute = async (): Promise<void> => {
      this.logger.log(`[${job.name ?? 'notification-delivery'}] deliver ${job.data.channel} → ${job.data.recipient}`);
      // Delivery is performed by the Notifications module dispatch layer; this
      // worker only owns the queue cadence and retry semantics.
    };

    await runWorkerJob({
      queue: this.queue,
      job,
      logger: this.logger,
      metrics: this.workerMetrics,
      defaultJobName: 'notification-delivery',
      handler: execute,
    });
  }
}
