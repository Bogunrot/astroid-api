/**
 * BullMQ job types for webhook delivery with retry logic.
 */

import { QueueJobMetadata } from '../../../queues/queues.constants';

export interface WebhookJobData {
  webhookId: string;
  organizationId: string;
  url: string;
  eventName: string;
  payload: unknown;
  eventId: string;
  metadata?: QueueJobMetadata;
}

export interface WebhookJobResult {
  success: boolean;
  statusCode?: number;
  error?: string;
}
