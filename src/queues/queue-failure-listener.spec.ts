import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { Logger } from '@nestjs/common';
import { Queues } from './queues.constants';

const getJob = vi.fn();
const add = vi.fn();
const close = vi.fn();
const eventsOn = vi.fn();

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation((name: string) => ({
    name,
    getJob,
    add,
    close: (...args: unknown[]) => {
      close(...args);
      return Promise.resolve();
    },
  })),
  QueueEvents: vi.fn().mockImplementation((name: string) => ({
    name,
    on: eventsOn,
    close: (...args: unknown[]) => {
      close(...args);
      return Promise.resolve();
    },
  })),
}));

vi.mock('../config/redis.config', () => ({
  redisConfig: () => ({ host: 'localhost', port: 6379, password: '', db: 0 }),
}));

import { QueueFailureListener } from './queue-failure-listener';

/** A job that has burned through every retry attempt. */
function exhaustedJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-123',
    name: 'webhook-delivery',
    data: { webhookId: 'wh-1', organizationId: 'org-1' },
    attemptsMade: 3,
    stacktrace: ['Error: HTTP 500 (attempt 3)'],
    opts: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
    ...overrides,
  };
}

describe('QueueFailureListener', () => {
  let listener: QueueFailureListener;
  let errorSpy: MockInstance;
  let warnSpy: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    listener = new QueueFailureListener();
  });

  /** Reads back the structured JSON payload passed to a Logger call. */
  function loggedRecord(spy: MockInstance, call = 0): Record<string, unknown> {
    return JSON.parse(String(spy.mock.calls[call][0]));
  }

  describe('onModuleInit', () => {
    it('attaches failed and stalled listeners to every named queue', () => {
      listener.onModuleInit();

      const queueCount = Object.keys(Queues).length;
      expect(listener.observedQueueCount).toBe(queueCount);
      expect(eventsOn).toHaveBeenCalledTimes(queueCount * 2);

      const events = eventsOn.mock.calls.map((call) => call[0]);
      expect(events.filter((e: string) => e === 'failed')).toHaveLength(queueCount);
      expect(events.filter((e: string) => e === 'stalled')).toHaveLength(queueCount);
    });

    it('does not reject when an event handler is invoked', async () => {
      listener.onModuleInit();
      getJob.mockResolvedValue(exhaustedJob());

      const failedHandler = eventsOn.mock.calls.find((c) => c[0] === 'failed')?.[1] as (
        args: unknown,
      ) => void;
      expect(() => failedHandler({ jobId: 'job-123', failedReason: 'HTTP 500' })).not.toThrow();

      // Let the fire-and-forget dispatch settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe('handleFailed', () => {
    it('logs a structured error payload with the full failure context', async () => {
      getJob.mockResolvedValue(exhaustedJob());

      const record = await listener.handleFailed(Queues.Webhooks, {
        jobId: 'job-123',
        failedReason: 'HTTP 500',
      });

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = loggedRecord(errorSpy);
      expect(logged).toMatchObject({
        event: 'failed',
        queue: 'webhooks',
        jobId: 'job-123',
        jobName: 'webhook-delivery',
        attemptsMade: 3,
        maxAttempts: 3,
        failedReason: 'HTTP 500',
        terminal: true,
      });
      expect(logged.stacktrace).toEqual(['Error: HTTP 500 (attempt 3)']);
      expect(logged.payload).toMatchObject({ webhookId: 'wh-1' });
      expect(typeof logged.observedAt).toBe('string');
      expect(record).not.toBeNull();
    });

    it('includes the human-readable summary as the log message', async () => {
      getJob.mockResolvedValue(exhaustedJob());

      await listener.handleFailed(Queues.Webhooks, { jobId: 'job-123', failedReason: 'HTTP 500' });

      const message = String(errorSpy.mock.calls[0][1]);
      expect(message).toContain("queue 'webhooks'");
      expect(message).toContain('failed terminally after 3 attempts');
      expect(message).toContain('HTTP 500');
    });

    it('extracts request tracing context from the job payload', async () => {
      getJob.mockResolvedValue(
        exhaustedJob({
          data: {
            organizationId: 'org-1',
            agentId: 'agent-7',
            traceId: 'trace-abc',
            correlationId: 'corr-abc',
            requestId: 'req-abc',
          },
        }),
      );

      await listener.handleFailed(Queues.Transactions, { jobId: 'job-123', failedReason: 'timeout' });

      expect(loggedRecord(errorSpy).trace).toEqual({
        traceId: 'trace-abc',
        correlationId: 'corr-abc',
        requestId: 'req-abc',
        organizationId: 'org-1',
        agentId: 'agent-7',
      });
    });

    it('marks a mid-retry failure as non-terminal and does not dead-letter it', async () => {
      getJob.mockResolvedValue(
        exhaustedJob({ attemptsMade: 1, stacktrace: ['Error: HTTP 503 (attempt 1)'] }),
      );

      const record = await listener.handleFailed(Queues.Webhooks, {
        jobId: 'job-123',
        failedReason: 'HTTP 503',
      });

      expect(record?.terminal).toBe(false);
      expect(add).not.toHaveBeenCalled();
      expect(String(errorSpy.mock.calls[0][1])).toContain('failed (attempt 1/3)');
    });

    it('treats an UnrecoverableError as terminal on the first attempt', async () => {
      getJob.mockResolvedValue(
        exhaustedJob({
          attemptsMade: 1,
          stacktrace: ['UnrecoverableError: HTTP 422 validation failed'],
        }),
      );

      const record = await listener.handleFailed(Queues.Webhooks, {
        jobId: 'job-422',
        failedReason: 'UnrecoverableError: HTTP 422 validation failed',
      });

      expect(record?.terminal).toBe(true);
      expect(add).toHaveBeenCalledTimes(1);
    });

    it('routes a terminal failure to the dead-letter queue with trace metadata', async () => {
      listener.onModuleInit();
      getJob.mockResolvedValue(exhaustedJob({ data: { organizationId: 'org-1', traceId: 'trace-9' } }));

      await listener.handleFailed(Queues.Webhooks, { jobId: 'job-123', failedReason: 'HTTP 500' });

      const dlqAdd = add.mock.calls.find((call: unknown[]) => {
        const opts = call[2] as { removeOnComplete?: unknown } | undefined;
        return opts?.removeOnComplete !== undefined;
      });
      expect(dlqAdd).toBeDefined();
      const [name, data, opts] = dlqAdd as [string, Record<string, unknown>, Record<string, unknown>];
      expect(name).toBe('dlq:webhooks:job-123');
      expect(data).toMatchObject({
        originalQueue: 'webhooks',
        originalJobId: 'job-123',
        originalJobName: 'webhook-delivery',
        failedReason: 'HTTP 500',
        attemptsMade: 3,
      });
      expect(data.metadata).toMatchObject({ maxAttempts: 3, organizationId: 'org-1', traceId: 'trace-9' });
      expect(opts.removeOnFail).toEqual({ age: 7 * 24 * 3600 });
    });

    it('scrubs secrets from the log line but keeps the raw payload for dead-letter re-drive', async () => {
      listener.onModuleInit();
      getJob.mockResolvedValue(
        exhaustedJob({
          data: { webhookId: 'wh-1', secret: 'whsec_live' },
          stacktrace: ['Error: auth failed with Bearer abc.def.ghi'],
        }),
      );

      await listener.handleFailed(Queues.Webhooks, {
        jobId: 'job-123',
        failedReason: 'auth failed with Bearer abc.def.ghi',
      });

      const line = String(errorSpy.mock.calls[0][0]);
      expect(line).not.toContain('whsec_live');
      expect(line).not.toContain('abc.def.ghi');
      expect(loggedRecord(errorSpy).payload).toEqual({ webhookId: 'wh-1', secret: '[REDACTED]' });

      const dlqAdd = add.mock.calls.find((call: unknown[]) => String(call[0]).startsWith('dlq:'));
      expect((dlqAdd?.[1] as { payload: unknown }).payload).toEqual({
        webhookId: 'wh-1',
        secret: 'whsec_live',
      });
    });

    it('never re-routes a failure that already came from the dead-letter queue', async () => {
      listener.onModuleInit();
      getJob.mockResolvedValue(exhaustedJob());

      const record = await listener.handleFailed(Queues.DeadLetter, {
        jobId: 'job-123',
        failedReason: 'boom',
      });

      expect(record?.terminal).toBe(true);
      expect(add).not.toHaveBeenCalled();
    });

    it('warns and returns null when the event carries no job id', async () => {
      const record = await listener.handleFailed(Queues.Webhooks, {});

      expect(record).toBeNull();
      expect(loggedRecord(warnSpy)).toMatchObject({
        event: 'failed',
        queue: 'webhooks',
        reason: 'missing-job-id',
      });
    });

    it('still logs and does not throw when the job record is already gone', async () => {
      getJob.mockResolvedValue(null);

      const record = await listener.handleFailed(Queues.Notifications, {
        jobId: 'gone',
        failedReason: 'timeout',
      });

      expect(record).toMatchObject({ jobId: 'gone', attemptsMade: 0, terminal: false });
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('never throws when reading the job from Redis fails', async () => {
      getJob.mockRejectedValue(new Error('redis unavailable'));

      await expect(
        listener.handleFailed(Queues.Webhooks, { jobId: 'job-123', failedReason: 'boom' }),
      ).resolves.not.toThrow();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('"event":"job-lookup-failed"'),
      );
    });

    it('never throws when the dead-letter enqueue fails', async () => {
      listener.onModuleInit();
      getJob.mockResolvedValue(exhaustedJob());
      add.mockRejectedValueOnce(new Error('redis write failed'));

      await expect(
        listener.handleFailed(Queues.Webhooks, { jobId: 'job-123', failedReason: 'HTTP 500' }),
      ).resolves.not.toThrow();

      const routed = errorSpy.mock.calls.find((call) =>
        String(call[0]).includes('dead-letter-route-failed'),
      );
      expect(routed).toBeDefined();
      expect(String(routed?.[0])).toContain('redis write failed');
    });

    it('serializes a payload that cannot be JSON-serialized', async () => {
      const cyclic: Record<string, unknown> = { organizationId: 'org-1' };
      cyclic.self = cyclic;
      getJob.mockResolvedValue(exhaustedJob({ data: cyclic }));

      const record = await listener.handleFailed(Queues.Webhooks, {
        jobId: 'job-123',
        failedReason: 'HTTP 500',
      });

      expect(typeof record?.payload).toBe('string');
    });
  });

  describe('handleStalled', () => {
    it('logs a structured warning and never dead-letters the job', async () => {
      listener.onModuleInit();
      getJob.mockResolvedValue(exhaustedJob({ attemptsMade: 2 }));

      const record = await listener.handleStalled(Queues.Transactions, { jobId: 'job-77' });

      expect(record).toMatchObject({
        event: 'stalled',
        queue: 'transactions',
        jobId: 'job-77',
        attemptsMade: 0,
        terminal: false,
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('"event":"stalled"'),
        expect.stringContaining('it will be reprocessed'),
      );
      expect(add).not.toHaveBeenCalled();
    });

    it('warns and returns null when the event carries no job id', async () => {
      const record = await listener.handleStalled(Queues.Transactions, {});

      expect(record).toBeNull();
      expect(loggedRecord(warnSpy)).toMatchObject({
        event: 'stalled',
        reason: 'missing-job-id',
      });
    });
  });

  describe('onModuleDestroy', () => {
    it('closes every event stream and every opened queue handle', async () => {
      listener.onModuleInit();
      getJob.mockResolvedValue(exhaustedJob());
      // Touching a job lazily opens and caches a handle for that queue.
      await listener.handleFailed(Queues.Webhooks, { jobId: 'job-123', failedReason: 'HTTP 500' });

      // QueueEvents per queue + a handle for the failed job and one for the DLQ.
      const expected = Object.keys(Queues).length + 2;

      await listener.onModuleDestroy();

      expect(close).toHaveBeenCalledTimes(expected);
      expect(listener.observedQueueCount).toBe(0);
    });

    it('opens no queue handle until one is needed', async () => {
      listener.onModuleInit();

      await listener.onModuleDestroy();

      expect(close).toHaveBeenCalledTimes(Object.keys(Queues).length);
    });

    it('never throws when a close rejects', async () => {
      listener.onModuleInit();
      close.mockRejectedValueOnce(new Error('already closed'));

      await expect(listener.onModuleDestroy()).resolves.toBeUndefined();
    });
  });
});
