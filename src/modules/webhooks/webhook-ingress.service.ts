import { Injectable, Logger } from '@nestjs/common';
import { IncomingWebhookInput } from './webhook-ingress.dto';

/**
 * Handles validated, signature-verified inbound webhook events from external
 * partner services and oracle providers.
 */
@Injectable()
export class WebhookIngressService {
  private readonly logger = new Logger(WebhookIngressService.name);

  async handle(event: IncomingWebhookInput): Promise<void> {
    this.logger.log(`Received inbound webhook event ${event.eventId} (${event.eventType})`);
  }
}
