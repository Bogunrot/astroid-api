import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { WebhookRepository } from './webhook.repository';
import { WebhookDeliveryService } from './services/webhook-delivery.service';
import { DomainEventEnvelope } from '../../events/domain-event.types';
import { DOMAIN_EVENT_ENVELOPE } from '../../events/domain-event.types';
import { WEBHOOK_EVENTS } from '../../events/event-names';

/**
 * Delivers domain events to subscribed external webhooks using BullMQ queue.
 * Each delivery is signed with the webhook's HMAC secret (`x-astroid-signature`) so receivers can
 * verify authenticity. The secret itself is never logged. Delivery is
 * asynchronous with exponential backoff retry logic — one failing endpoint never blocks
 * others or the originating operation.
 */
@Injectable()
export class WebhookDispatcher {
  private readonly logger = new Logger(WebhookDispatcher.name);

  constructor(
    private readonly repository: WebhookRepository,
    private readonly deliveryService: WebhookDeliveryService,
  ) {}

  @OnEvent(DOMAIN_EVENT_ENVELOPE)
  async dispatch(envelope: DomainEventEnvelope): Promise<void> {
    if (!envelope?.organizationId) {
      return;
    }
    // Only forward the curated set of externally-relevant events.
    if (!WEBHOOK_EVENTS.includes(envelope.name)) {
      return;
    }

    const webhooks = await this.repository.findEnabledForEvent(
      envelope.organizationId,
      envelope.name,
    );
    if (webhooks.length === 0) {
      return;
    }

    const payload = {
      event: envelope.name,
      occurredAt: envelope.occurredAt,
      aggregateType: envelope.aggregateType,
      aggregateId: envelope.aggregateId,
      data: envelope.payload,
    };

    await Promise.all(
      webhooks.map(async (webhook) => {
        try {
          await this.deliveryService.queueDelivery({
            webhookId: webhook.id,
            organizationId: envelope.organizationId || '',
            url: webhook.url,
            eventName: envelope.name,
            payload,
            eventId: envelope.eventId ?? `${envelope.name}-${envelope.aggregateType}-${envelope.aggregateId ?? 'unknown'}-${envelope.occurredAt.getTime()}`,
          });
        } catch {
          this.logger.error(`Failed to queue webhook ${webhook.id} for '${envelope.name}'`);
        }
      }),
    );
  }
}
