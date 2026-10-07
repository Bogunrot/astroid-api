import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

import { Queues } from '../../../queues/queues.constants';
import { WEBHOOK_JOB_NAME, webhookJobOptions } from '../../../queues/webhook.queue';
import { WebhookJobData } from '../types/webhook-job.types';
import { RequestContext } from '../../../common/context/request-context';
import { resolveRequestId } from '../../../common/helpers/request-id';

/**
 * Service for queuing webhook delivery jobs with BullMQ.
 *
 * Retry policy, jittered backoff and dead-letter settings come from
 * `@queues/webhook.queue` so the API-side enqueue options and the worker-side
 * queue registration can never drift apart.
 */
@Injectable()
export class WebhookDeliveryService {
  private readonly logger = new Logger(WebhookDeliveryService.name);

  constructor(
    @InjectQueue(Queues.Webhooks)
    private readonly webhookQueue: Queue<WebhookJobData>,
  ) {}

  /**
   * Queues a webhook delivery job.
   *
   * The job inherits the queue's retry policy: 5 attempts, exponential backoff
   * (2000ms base) with ±20% jitter applied by the custom backoff strategy, and
   * 24h retention of failed jobs so exhausted deliveries remain inspectable.
   */
  async queueDelivery(data: WebhookJobData): Promise<void> {
    try {
      const metadata = {
        ...data.metadata,
        requestId: data.metadata?.requestId ?? RequestContext.getRequestId() ?? resolveRequestId(undefined),
        correlationId: data.metadata?.correlationId ?? RequestContext.getCorrelationId(),
        traceId: data.metadata?.traceId ?? RequestContext.getTraceId(),
      };
      metadata.correlationId ??= metadata.requestId;
      metadata.traceId ??= metadata.correlationId;
      const hasMetadata = Object.values(metadata).some((value) => value !== undefined);
      const jobData: WebhookJobData = {
        ...data,
        ...(hasMetadata ? { metadata } : {}),
      };
      await this.webhookQueue.add(WEBHOOK_JOB_NAME, jobData, webhookJobOptions);
      this.logger.debug(`Queued webhook delivery for ${data.eventName} to ${data.url}`);
    } catch (error) {
      this.logger.error('Failed to queue webhook delivery');
      throw error;
    }
  }
}

