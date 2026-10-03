import { describe, expect, it, vi, beforeEach } from 'vitest';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { Queue } from 'bullmq';
import { WebhookJobData } from '../types/webhook-job.types';

describe('WebhookDeliveryService', () => {
  let service: WebhookDeliveryService;
  let mockQueue: Queue<WebhookJobData>;

  beforeEach(() => {
    mockQueue = {
      add: vi.fn().mockResolvedValue({ id: 'job-1' }),
    } as unknown as Queue<WebhookJobData>;
    service = new WebhookDeliveryService(mockQueue);
  });

  const createJobData = (overrides: Partial<WebhookJobData> = {}): WebhookJobData => ({
    webhookId: 'webhook-1',
    organizationId: 'org-1',
    url: 'https://example.com/webhook',
    eventName: 'transaction.created',
    payload: { id: 'txn-1' },
    eventId: 'event-1',
    ...overrides,
  });

  it('queues a webhook delivery job with correct configuration', async () => {
    const jobData = createJobData();
    await service.queueDelivery(jobData);

    expect(mockQueue.add).toHaveBeenCalledWith(
      'webhook-delivery',
      expect.objectContaining({
        ...jobData,
        metadata: {
          requestId: expect.any(String),
          correlationId: expect.any(String),
          traceId: expect.any(String),
        },
      }),
      {
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: { count: 1000 },
        removeOnFail: { age: 24 * 3600 },
      },
    );
  });

  it('queues webhook with custom event name', async () => {
    const jobData = createJobData({ eventName: 'payment.completed' });
    await service.queueDelivery(jobData);

    expect(mockQueue.add).toHaveBeenCalledWith(
      'webhook-delivery',
      expect.objectContaining({ ...jobData, metadata: expect.objectContaining({ requestId: expect.any(String) }) }),
      expect.any(Object),
    );
  });

  it('queues webhook with custom URL', async () => {
    const jobData = createJobData({ url: 'https://custom.example.com/hook' });
    await service.queueDelivery(jobData);

    expect(mockQueue.add).toHaveBeenCalledWith(
      'webhook-delivery',
      expect.objectContaining({ ...jobData, metadata: expect.objectContaining({ requestId: expect.any(String) }) }),
      expect.any(Object),
    );
  });

  it('queues webhook with custom payload', async () => {
    const customPayload = { transactionId: 'txn-123', amount: 100 };
    const jobData = createJobData({ payload: customPayload });
    await service.queueDelivery(jobData);

    expect(mockQueue.add).toHaveBeenCalledWith(
      'webhook-delivery',
      expect.objectContaining({ ...jobData, metadata: expect.objectContaining({ requestId: expect.any(String) }) }),
      expect.any(Object),
    );
  });

  it('throws error when queue add fails', async () => {
    const error = new Error('Redis connection failed');
    vi.mocked(mockQueue.add).mockRejectedValue(error);

    const jobData = createJobData();
    await expect(service.queueDelivery(jobData)).rejects.toThrow('Redis connection failed');
  });

  it('configures exponential backoff with 2000ms base delay', async () => {
    const jobData = createJobData();
    await service.queueDelivery(jobData);

    const callArgs = vi.mocked(mockQueue.add).mock.calls[0];
    expect(callArgs?.[2]?.backoff).toEqual({
      type: 'exponential',
      delay: 2000,
    });
  });

  it('configures 5 retry attempts', async () => {
    const jobData = createJobData();
    await service.queueDelivery(jobData);

    const callArgs = vi.mocked(mockQueue.add).mock.calls[0];
    expect(callArgs?.[2]?.attempts).toBe(5);
  });

  it('configures job removal after 1000 completed jobs', async () => {
    const jobData = createJobData();
    await service.queueDelivery(jobData);

    const callArgs = vi.mocked(mockQueue.add).mock.calls[0];
    expect(callArgs?.[2]?.removeOnComplete).toEqual({ count: 1000 });
  });

  it('configures failed job removal after 24 hours', async () => {
    const jobData = createJobData();
    await service.queueDelivery(jobData);

    const callArgs = vi.mocked(mockQueue.add).mock.calls[0];
    expect(callArgs?.[2]?.removeOnFail).toEqual({ age: 24 * 3600 });
  });

  it('handles queueing multiple webhooks sequentially', async () => {
    const jobData1 = createJobData({ eventId: 'event-1' });
    const jobData2 = createJobData({ eventId: 'event-2' });
    const jobData3 = createJobData({ eventId: 'event-3' });

    await service.queueDelivery(jobData1);
    await service.queueDelivery(jobData2);
    await service.queueDelivery(jobData3);

    expect(mockQueue.add).toHaveBeenCalledTimes(3);
  });
});
