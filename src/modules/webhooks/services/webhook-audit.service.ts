import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../../audit/audit.service';

/** Everything needed to reconstruct why a webhook delivery was abandoned. */
export interface WebhookDeliveryFailure {
  webhookId: string;
  organizationId: string;
  url: string;
  attemptsMade: number;
  failedReason: string;
  eventName?: string;
  eventId?: string;
  responseStatus?: number;
}

/** Audit action recorded for a webhook that exhausted every retry attempt. */
export const WEBHOOK_DELIVERY_FAILED_ACTION = 'WEBHOOK_DELIVERY_FAILED';

/**
 * Writes permanently failed webhook deliveries into the compliance audit trail.
 *
 * A webhook that exhausts its retries has been moved to the dead-letter queue by
 * the queue failure listener; this service adds the *business* record — which
 * subscriber, which event, how many attempts, and why it died — so an operator
 * can answer "did the agent's approval notification ever arrive?" from the audit
 * log alone.
 *
 * Auditing is best-effort by design: it runs inside a worker whose job is to
 * deliver notifications, and a logging failure must never turn into a crashed
 * or endlessly-retried job.
 */
@Injectable()
export class WebhookAuditService {
  private readonly logger = new Logger(WebhookAuditService.name);

  constructor(private readonly auditService: AuditService) {}

  /** Appends one `WEBHOOK_DELIVERY_FAILED` entry. Never throws. */
  async recordTerminalFailure(failure: WebhookDeliveryFailure): Promise<void> {
    try {
      await this.auditService.record({
        organizationId: failure.organizationId,
        userId: null,
        action: WEBHOOK_DELIVERY_FAILED_ACTION,
        entity: 'Webhook',
        entityId: failure.webhookId,
        newValue: {
          url: failure.url,
          eventName: failure.eventName ?? null,
          eventId: failure.eventId ?? null,
          attemptsMade: failure.attemptsMade,
          responseStatus: failure.responseStatus ?? null,
          failedReason: failure.failedReason,
          deadLettered: true,
        } as unknown as Prisma.InputJsonValue,
      });
    } catch (error) {
      this.logger.error(
        `Failed to audit webhook ${failure.webhookId} delivery failure: ${(error as Error).message}`,
      );
    }
  }
}
