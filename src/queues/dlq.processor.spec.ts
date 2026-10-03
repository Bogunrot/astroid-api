import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Job, Queue } from 'bullmq';
import { DlqProcessor } from './dlq.processor';
import { DlqJobData, Queues } from './queues.constants';

vi.mock('../utils/retry.util', () => ({
  retryWithBackoff: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

describe('DlqProcessor', () => {
  let processor: DlqProcessor;
  let mockPrisma: Record<string, unknown>;
  let mockDomainEventCreate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockDomainEventCreate = vi.fn().mockResolvedValue({ id: 'event-1' });
    mockPrisma = {
      domainEvent: {
        create: mockDomainEventCreate,
      },
    };
    processor = new DlqProcessor(mockPrisma as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('process', () => {
    it('processes a dead-letter job, logs details, and records an audit domain event', async () => {
      const mockJobData: DlqJobData = {
        originalQueue: Queues.Webhooks,
        originalJobId: 'job-123',
        originalJobName: 'deliver-webhook',
        payload: { webhookId: 'wh-1', event: 'payment.completed' },
        failedReason: 'HTTP 500: Internal Server Error',
        stacktrace: ['Error: HTTP 500 at fetch'],
        attemptsMade: 5,
        failedAt: '2026-08-30T21:00:00.000Z',
      };

      const mockJob = {
        id: 'dlq-job-1',
        data: mockJobData,
      } as unknown as Job<DlqJobData>;

      const result = await processor.process(mockJob);

      expect(result.handled).toBe(true);
      expect(result.deadLetteredAt).toBe('2026-08-30T21:00:00.000Z');
      expect(mockDomainEventCreate).toHaveBeenCalledWith({
        data: {
          name: 'job.dead_lettered',
          aggregateType: 'DEAD_LETTER_QUEUE',
          aggregateId: 'job-123',
          payload: {
            originalQueue: Queues.Webhooks,
            originalJobName: 'deliver-webhook',
            failedReason: 'HTTP 500: Internal Server Error',
            stacktrace: ['Error: HTTP 500 at fetch'],
            payload: { webhookId: 'wh-1', event: 'payment.completed' },
            attemptsMade: 5,
            failedAt: '2026-08-30T21:00:00.000Z',
          },
        },
      });
    });

    it('persists the stack trace and original payload in the audit event for forensic inspection', async () => {
      const mockJobData: DlqJobData = {
        originalQueue: Queues.Transactions,
        originalJobId: 'tx-789',
        originalJobName: 'execute-transaction',
        payload: { transactionId: 'tx-789', amount: '100' },
        failedReason: 'Horizon timeout',
        stacktrace: ['Error: Horizon timeout', '    at submit (worker.ts:42:11)'],
        attemptsMade: 3,
        failedAt: '2026-08-30T21:10:00.000Z',
      };

      const mockJob = {
        id: 'dlq-job-3',
        data: mockJobData,
      } as unknown as Job<DlqJobData>;

      await processor.process(mockJob);

      expect(mockDomainEventCreate).toHaveBeenCalledTimes(1);
      const event = mockDomainEventCreate.mock.calls[0][0] as {
        data: { payload: Record<string, unknown> };
      };
      expect(event.data.payload).toMatchObject({
        originalQueue: Queues.Transactions,
        failedReason: 'Horizon timeout',
        stacktrace: ['Error: Horizon timeout', '    at submit (worker.ts:42:11)'],
        payload: { transactionId: 'tx-789', amount: '100' },
        attemptsMade: 3,
      });
    });

    it('gracefully handles missing database client without throwing errors', async () => {
      const processorNoDb = new DlqProcessor(undefined);
      const mockJobData: DlqJobData = {
        originalQueue: Queues.Transactions,
        originalJobId: 'tx-456',
        payload: { transactionId: 'tx-456' },
        failedReason: 'Insufficient funds',
        attemptsMade: 3,
        failedAt: '2026-08-30T21:05:00.000Z',
      };

      const mockJob = {
        id: 'dlq-job-2',
        data: mockJobData,
      } as unknown as Job<DlqJobData>;

      const result = await processorNoDb.process(mockJob);
      expect(result.handled).toBe(true);
    });

    it('retries the audit write on a transient database error', async () => {
      const { retryWithBackoff } = await import('../utils/retry.util');
      (retryWithBackoff as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async (fn: () => Promise<unknown>, opts: { maxAttempts?: number }) => {
          // Simulate two failures then success on the third attempt.
          let attempts = 0;
          while (attempts < (opts.maxAttempts ?? 3) - 1) {
            attempts++;
            try { await fn(); } catch { /* keep retrying */ }
          }
          return fn();
        },
      );

      const flaky = vi.fn()
        .mockRejectedValueOnce(new Error('connection reset'))
        .mockRejectedValueOnce(new Error('connection reset'))
        .mockResolvedValue({ id: 'event-2' });
      mockPrisma = { domainEvent: { create: flaky } };
      processor = new DlqProcessor(mockPrisma as never);

      const mockJob = {
        id: 'dlq-job-retry',
        data: {
          originalQueue: Queues.Webhooks,
          originalJobId: 'job-retry',
          payload: {},
          failedReason: 'transient',
          attemptsMade: 1,
          failedAt: new Date().toISOString(),
        },
      } as unknown as Job<DlqJobData>;

      const result = await processor.process(mockJob);
      expect(result.handled).toBe(true);
    });

    it('stops retrying and logs an error on a non-retryable constraint violation', async () => {
      const { retryWithBackoff } = await import('../utils/retry.util');
      (retryWithBackoff as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async (_fn: () => Promise<unknown>, opts: { isRetryable?: (e: unknown) => boolean }) => {
          const err = new Error('NOT NULL constraint failed: domainEvent.aggregateId');
          if (opts.isRetryable && !opts.isRetryable(err)) throw err;
          throw err;
        },
      );

      const nonRetryableCreate = vi.fn().mockRejectedValue(
        new Error('NOT NULL constraint failed: domainEvent.aggregateId'),
      );
      mockPrisma = { domainEvent: { create: nonRetryableCreate } };
      processor = new DlqProcessor(mockPrisma as never);

      const errorSpy = vi.spyOn(processor['logger'], 'error').mockImplementation(() => undefined);

      const mockJob = {
        id: 'dlq-job-constraint',
        data: {
          originalQueue: Queues.Transactions,
          originalJobId: 'tx-constraint',
          payload: {},
          failedReason: 'constraint',
          attemptsMade: 1,
          failedAt: new Date().toISOString(),
        },
      } as unknown as Job<DlqJobData>;

      const result = await processor.process(mockJob);
      expect(result.handled).toBe(true);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to record DLQ audit event after retries'),
      );
    });
  });

  describe('moveToDeadLetter static helper', () => {
    it('constructs correct DlqJobData and adds job to the DLQ queue', async () => {
      const mockDlqQueue = {
        add: vi.fn().mockResolvedValue({ id: 'dlq-added-1' }),
      } as unknown as Queue<DlqJobData>;

      const originalFailedJob = {
        id: 'orig-job-999',
        name: 'sync-stellar-balance',
        data: { walletId: 'wallet-1', address: 'GABC123' },
        attemptsMade: 3,
        stacktrace: ['Error: Horizon connection timeout'],
        timestamp: 1725050000000,
        processedOn: 1725050001000,
        finishedOn: 1725050005000,
      } as unknown as Job;

      const error = new Error('Horizon connection timeout');

      const result = await DlqProcessor.moveToDeadLetter(
        mockDlqQueue,
        originalFailedJob,
        error,
        Queues.StellarSync,
      );

      expect(mockDlqQueue.add).toHaveBeenCalledWith(
        expect.stringContaining('dlq:stellar-sync:orig-job-999'),
        expect.objectContaining({
          originalQueue: Queues.StellarSync,
          originalJobId: 'orig-job-999',
          originalJobName: 'sync-stellar-balance',
          payload: { walletId: 'wallet-1', address: 'GABC123' },
          failedReason: 'Horizon connection timeout',
          attemptsMade: 3,
        }),
        expect.any(Object),
      );
      expect(result).toEqual({ id: 'dlq-added-1' });
    });
  });
});
