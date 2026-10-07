import { describe, expect, it } from 'vitest';

import { Queues } from './queues.constants';
import {
  WEBHOOK_BACKOFF_BASE_DELAY_MS,
  WEBHOOK_DEAD_LETTER_QUEUE,
  WEBHOOK_JOB_NAME,
  WEBHOOK_MAX_ATTEMPTS,
  createWebhookQueueOptions,
  webhookJobOptions,
} from './webhook.queue';

describe('webhook queue configuration', () => {
  it('retries a delivery five times with exponential backoff', () => {
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(5);
    expect(WEBHOOK_BACKOFF_BASE_DELAY_MS).toBe(2_000);
    expect(webhookJobOptions.attempts).toBe(5);
    expect(webhookJobOptions.backoff).toEqual({ type: 'exponential', delay: 2_000 });
  });

  it('keeps completed jobs bounded and failed jobs inspectable for a day', () => {
    expect(webhookJobOptions.removeOnComplete).toEqual({ count: 1_000 });
    expect(webhookJobOptions.removeOnFail).toEqual({ age: 24 * 3_600 });
  });

  it('registers the queue under the webhook name with the shared job options', () => {
    const options = createWebhookQueueOptions();

    expect(options.name).toBe(Queues.Webhooks);
    expect(options.defaultJobOptions).toEqual(webhookJobOptions);
  });

  it('attaches a jittered backoff strategy so retries never fire in lockstep', () => {
    const settings = createWebhookQueueOptions().settings as unknown as {
      backoffStrategy: (attemptsMade: number) => number;
    };

    const firstRetry = settings.backoffStrategy(0);
    expect(firstRetry).toBeGreaterThanOrEqual(2_000);
    expect(firstRetry).toBeLessThan(2_400);

    // The second retry doubles the base delay while still staying inside the
    // 20% jitter envelope.
    const secondRetry = settings.backoffStrategy(1);
    expect(secondRetry).toBeGreaterThanOrEqual(4_000);
    expect(secondRetry).toBeLessThan(4_800);
  });

  it('routes permanently failed deliveries to the dead-letter queue', () => {
    expect(WEBHOOK_DEAD_LETTER_QUEUE).toBe(Queues.DeadLetter);
  });

  it('uses a single well-known job name for every delivery', () => {
    expect(WEBHOOK_JOB_NAME).toBe('webhook-delivery');
  });
});
