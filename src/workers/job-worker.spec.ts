import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoggerService } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { runWorkerJob, type WorkerJob } from './job-worker';

vi.mock('../queues/queue.module', () => ({
  DEFAULT_JOB_OPTIONS: { attempts: 3, backoff: { type: 'exponential', delay: 1_000 } },
}));

vi.mock('./dlq.processor', () => ({
  isTerminalJobFailure: vi.fn(
    (job: { attemptsMade: number; opts: { attempts: number } }) =>
      job.attemptsMade >= job.opts.attempts,
  ),
}));

vi.mock('../utils/log-scrubber.util', () => ({
  scrubForLog: vi.fn((v: unknown) => v),
  scrubString: vi.fn((s: string) => s),
}));

const STELLAR_SEED = 'SCZANGBA5YHTNYVVV4C3U252E2B6P6F5T3U6MM63WBSBZATAQI3EBTQ4';

function makeLogger() {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } satisfies Pick<LoggerService, 'log' | 'warn' | 'error' | 'debug'>;
}

function makeJob<T>(data: T, overrides: Partial<WorkerJob<T>> = {}): WorkerJob<T> {
  return {
    id: 'job-1',
    name: 'test-job',
    data,
    attemptsMade: 2,
    opts: { attempts: 3 },
    ...overrides,
  };
}

describe('runWorkerJob', () => {
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    logger = makeLogger();
    vi.clearAllMocks();
  });

  it('calls the handler and returns its result', async () => {
    const result = await runWorkerJob({
      queue: 'test-queue',
      job: makeJob({ amount: 100 }),
      logger,
      handler: async () => 'success',
    });

    expect(result).toBe('success');
  });

  it('calls metrics.instrumentJob when metrics are provided', async () => {
    const instrumentJob = vi.fn().mockResolvedValue('metered');
    const metrics = { instrumentJob } as unknown as Parameters<typeof runWorkerJob>[0]['metrics'];

    const result = await runWorkerJob({
      queue: 'test-queue',
      job: makeJob({ amount: 100 }),
      logger,
      metrics,
      defaultJobName: 'my-job',
      handler: async () => 'metered',
    });

    expect(instrumentJob).toHaveBeenCalledWith('test-queue', 'test-job', expect.any(Function));
    expect(result).toBe('metered');
  });

  it('does not call metrics.instrumentJob when metrics are omitted', async () => {
    const handler = vi.fn().mockResolvedValue('direct');

    await runWorkerJob({
      queue: 'test-queue',
      job: makeJob({ amount: 100 }),
      logger,
      handler,
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('uses defaultJobName when job.name is absent', async () => {
    const instrumentJob = vi.fn().mockResolvedValue(undefined);

    await runWorkerJob({
      queue: 'test-queue',
      job: makeJob({}, { name: undefined }),
      logger,
      metrics: { instrumentJob } as unknown as Parameters<typeof runWorkerJob>[0]['metrics'],
      defaultJobName: 'fallback-name',
      handler: async () => undefined,
    });

    expect(instrumentJob).toHaveBeenCalledWith('test-queue', 'fallback-name', expect.any(Function));
  });

  it('logs job.completed on success via debug when available', async () => {
    await runWorkerJob({
      queue: 'test-queue',
      job: makeJob({}),
      logger,
      handler: async () => undefined,
    });

    expect(logger.debug).toHaveBeenCalledTimes(1);
    const record = JSON.parse(String(logger.debug.mock.calls[0][0]));
    expect(record).toMatchObject({ event: 'job.completed', queue: 'test-queue', jobId: 'job-1' });
  });

  it('rethrows errors from the handler unchanged', async () => {
    const boom = new Error('handler blew up');
    await expect(
      runWorkerJob({
        queue: 'test-queue',
        job: makeJob({}),
        logger,
        handler: async () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);
  });

  it('logs job.retrying when retries remain', async () => {
    const job = makeJob({ walletId: 'w-1' }, { attemptsMade: 0, opts: { attempts: 3 } });

    await expect(
      runWorkerJob({
        queue: 'test-queue',
        job,
        logger,
        handler: async () => {
          throw new Error('transient failure');
        },
      }),
    ).rejects.toThrow('transient failure');

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const record = JSON.parse(String(logger.warn.mock.calls[0][0]));
    expect(record).toMatchObject({ event: 'job.retrying', attempt: 1, maxAttempts: 3 });
  });

  it('logs job.dead-lettered when retries are exhausted', async () => {
    const job = makeJob({ walletId: 'w-1' }, { attemptsMade: 2, opts: { attempts: 3 } });

    await expect(
      runWorkerJob({
        queue: 'test-queue',
        job,
        logger,
        handler: async () => {
          throw new Error('final failure');
        },
      }),
    ).rejects.toThrow('final failure');

    expect(logger.error).toHaveBeenCalledTimes(1);
    const record = JSON.parse(String(logger.error.mock.calls[0][0]));
    expect(record).toMatchObject({ event: 'job.dead-lettered', attempt: 3, maxAttempts: 3 });
  });

  it('treats UnrecoverableError as terminal on the first attempt', async () => {
    const job = makeJob({}, { attemptsMade: 0, opts: { attempts: 5 } });

    await expect(
      runWorkerJob({
        queue: 'test-queue',
        job,
        logger,
        handler: async () => {
          throw new UnrecoverableError('invalid payload');
        },
      }),
    ).rejects.toThrow('invalid payload');

    expect(logger.error).toHaveBeenCalledTimes(1);
    const record = JSON.parse(String(logger.error.mock.calls[0][0]));
    expect(record).toMatchObject({ event: 'job.dead-lettered', unrecoverable: true });
  });

  it('includes trace fields from top-level and nested job metadata', async () => {
    const job = makeJob(
      {
        organizationId: 'org-1',
        metadata: { requestId: 'req-123', correlationId: 'corr-123' },
        traceId: 'trace-abc',
        extra: 'noise',
      },
      { attemptsMade: 2, opts: { attempts: 3 } },
    );

    await expect(
      runWorkerJob({
        queue: 'test-queue',
        job,
        logger,
        handler: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow();

    const record = JSON.parse(String(logger.error.mock.calls[0][0]));
    expect(record.trace).toEqual({
      organizationId: 'org-1',
      requestId: 'req-123',
      correlationId: 'corr-123',
      traceId: 'trace-abc',
    });
    expect(record.trace.extra).toBeUndefined();
  });

  it('never throws when the logging side effect itself fails', async () => {
    logger.error.mockImplementation(() => {
      throw new Error('log transport down');
    });

    const job = makeJob({}, { attemptsMade: 2, opts: { attempts: 3 } });
    const boom = new Error('job error');

    // The original job error is still rethrown; the logging failure is swallowed.
    await expect(
      runWorkerJob({
        queue: 'test-queue',
        job,
        logger,
        handler: async () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);
  });

  it('includes durationMs in every log record', async () => {
    const job = makeJob({}, { attemptsMade: 2, opts: { attempts: 3 } });

    await expect(
      runWorkerJob({
        queue: 'test-queue',
        job,
        logger,
        handler: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow();

    const record = JSON.parse(String(logger.error.mock.calls[0][0]));
    expect(typeof record.durationMs).toBe('number');
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('masks a Stellar seed in the error message before logging', async () => {
    const { scrubString } = await import('../utils/log-scrubber.util');
    (scrubString as ReturnType<typeof vi.fn>).mockImplementation((s: string) =>
      s.replace(STELLAR_SEED, '[REDACTED]'),
    );

    const job = makeJob({}, { attemptsMade: 2, opts: { attempts: 3 } });

    await expect(
      runWorkerJob({
        queue: 'test-queue',
        job,
        logger,
        handler: async () => {
          throw new Error(`rejected seed ${STELLAR_SEED}`);
        },
      }),
    ).rejects.toThrow();

    const record = JSON.parse(String(logger.error.mock.calls[0][0]));
    expect(record.error.message).not.toContain(STELLAR_SEED);
    expect(record.error.message).toContain('[REDACTED]');
  });
});
