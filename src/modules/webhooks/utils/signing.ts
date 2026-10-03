import { createHmac, timingSafeEqual } from 'crypto';

export const WEBHOOK_SIGNATURE_VERSION = 'v1';

export function buildWebhookSignatureInput(
  timestamp: string,
  eventId: string,
  payload: Buffer,
): Buffer {
  return Buffer.concat([
    Buffer.from(`${WEBHOOK_SIGNATURE_VERSION}.${timestamp}.${eventId}.`, 'utf8'),
    payload,
  ]);
}

export function signWebhookPayload(
  secret: string,
  timestamp: string,
  eventId: string,
  payload: Buffer,
): string {
  const digest = createHmac('sha256', secret)
    .update(buildWebhookSignatureInput(timestamp, eventId, payload))
    .digest('hex');
  return `${WEBHOOK_SIGNATURE_VERSION}=${digest}`;
}

export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  eventId: string,
  payload: Buffer,
  signature: string,
): boolean {
  if (!/^\d{1,12}$/.test(timestamp) || !eventId || eventId.length > 256) return false;
  const match = /^v1=([0-9a-f]{64})$/.exec(signature);
  if (!match) return false;

  const expected = Buffer.from(signWebhookPayload(secret, timestamp, eventId, payload).slice(3), 'hex');
  const received = Buffer.from(match[1], 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}
