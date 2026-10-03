import { z } from 'zod';

/**
 * Schema for inbound webhook events received from external partner
 * services and oracle providers (validated after `WebhookSignatureGuard`
 * confirms the HMAC signature over the raw body).
 */
export const incomingWebhookSchema = z
  .object({
    eventId: z.string().min(1).max(255),
    eventType: z.string().min(1).max(120),
    data: z.record(z.unknown()),
  })
  .strict();
export type IncomingWebhookInput = z.infer<typeof incomingWebhookSchema>;
