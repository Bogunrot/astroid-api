import type { JobsOptions } from 'bullmq';
import type { RegisterQueueOptions } from '@nestjs/bullmq';

import { webhookBackoffStrategy } from '../utils/backoff.util';
import { Queues } from './queues.constants';

/** BullMQ job name used for every outbound webhook delivery. */
export const WEBHOOK_JOB_NAME = 'webhook-delivery';

/** Total delivery attempts (1 initial + 4 retries) before a webhook is dead-lettered. */
export const WEBHOOK_MAX_ATTEMPTS = 5;

/** Base delay in milliseconds for the exponential backoff between attempts. */
export const WEBHOOK_BACKOFF_BASE_DELAY_MS = 2_000;

/** Queue that permanently failed webhook deliveries are routed to for inspection. */
export const WEBHOOK_DEAD_LETTER_QUEUE = Queues.DeadLetter;

/**
 * Retry policy applied to every queued webhook delivery.
 *
 * - `attempts: 5` bounds the work spent on a dead endpoint.
 * - `backoff: exponential @ 2000ms` spaces retries out (2s, 4s, 8s, 16s).
 * - `removeOnFail.age: 24h` keeps exhausted jobs inspectable (and re-drivable)
 *   long enough for an operator to act, without growing Redis forever.
 */
export const webhookJobOptions: JobsOptions = {
  attempts: WEBHOOK_MAX_ATTEMPTS,
  backoff: {
    type: 'exponential',
    delay: WEBHOOK_BACKOFF_BASE_DELAY_MS,
  },
  removeOnComplete: { count: 1_000 },
  removeOnFail: { age: 24 * 3_600 },
};

/**
 * Builds the BullMQ registration for the webhook queue.
 *
 * The custom `backoffStrategy` adds ±20% randomized jitter on top of the
 * exponential delay so a fleet of failing subscribers is not retried in
 * lockstep (thundering herd). BullMQ reads the strategy from
 * `queue.opts.settings.backoffStrategy` at retry time; `@nestjs/bullmq` does not
 * surface that field on `RegisterQueueOptions`, hence the narrow cast.
 */
export function createWebhookQueueOptions(): RegisterQueueOptions {
  return {
    name: Queues.Webhooks,
    defaultJobOptions: webhookJobOptions,
    settings: {
      backoffStrategy: webhookBackoffStrategy,
    } as RegisterQueueOptions['settings'],
  };
}
