import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { signWebhookPayload, verifyWebhookSignature } from './signing';

describe('signWebhookPayload', () => {
  it('should generate expected signature', () => {
    const secret = 'test-secret';
    const timestamp = '1234567890';
    const payload = Buffer.from(JSON.stringify({ event: 'test.event' }));
    const eventId = 'evt-123';
    
    const signature = signWebhookPayload(secret, timestamp, eventId, payload);
    
    const expected = createHmac('sha256', secret)
      .update(Buffer.concat([Buffer.from(`v1.${timestamp}.${eventId}.`), payload]))
      .digest('hex');
    expect(signature).toBe(`v1=${expected}`);
    expect(verifyWebhookSignature(secret, timestamp, eventId, payload, signature)).toBe(true);
  });

  it('rejects altered payload, timestamp, event ID, and signature', () => {
    const secret = 'test-secret';
    const timestamp = '1234567890';
    const eventId = 'evt-123';
    const payload = Buffer.from('{"event":"test.event"}');
    const signature = signWebhookPayload(secret, timestamp, eventId, payload);

    expect(verifyWebhookSignature(secret, timestamp, eventId, Buffer.from('{}'), signature)).toBe(false);
    expect(verifyWebhookSignature(secret, '1234567891', eventId, payload, signature)).toBe(false);
    expect(verifyWebhookSignature(secret, timestamp, 'evt-124', payload, signature)).toBe(false);
    expect(verifyWebhookSignature(secret, timestamp, eventId, payload, 'v1=0'.repeat(64))).toBe(false);
  });
});
