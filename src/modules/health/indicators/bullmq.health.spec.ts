import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Queue } from 'bullmq';
import { BullMQHealthIndicator } from './bullmq.health';

const makeQueue = (overrides: Record<string, number> = {}) =>
  ({
    getJobCounts: vi.fn().mockResolvedValue({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      paused: 0,
      ...overrides,
    }),
    close: vi.fn().mockResolvedValue(undefined),
  }) as unknown as Queue;

describe('BullMQHealthIndicator', () => {
  let indicator: BullMQHealthIndicator;

  beforeEach(() => {
    vi.clearAllMocks();
    indicator = new BullMQHealthIndicator(100);
  });

  it('monitors the core BullMQ queues', () => {
    const queues = indicator.monitoredQueues;
    expect(queues).toContain('webhooks');
    expect(queues).toContain('risk-analysis');
    expect(queues).toContain('transactions');
    expect(queues).toContain('dead-letter');
    expect(queues).toContain('audit');
  });

  it('reports UP with job counts for all healthy queues', async () => {
    const handle = makeQueue({ waiting: 3, active: 1, completed: 50, failed: 2 });
    indicator.setQueueHandle('webhooks', handle);
    // Every queue without an explicit handle falls back to the same healthy mock.
    vi.spyOn(
      indicator as unknown as { getQueue: (name: string) => Queue },
      'getQueue',
    ).mockImplementation(() => handle);

    const report = await indicator.checkHealth();

    expect(report.status).toBe('up');
    expect(report.redis).toBe('up');
    const webhooks = report.queues.find((q) => q.queue === 'webhooks');
    expect(webhooks?.connection).toBe('up');
    expect(webhooks?.counts).toEqual({
      waiting: 3,
      active: 1,
      completed: 50,
      failed: 2,
      delayed: 0,
      paused: 0,
    });
    expect(report.queues.length).toBe(indicator.monitoredQueues.length);
  });

  it('reports DEGRADED when a subset of queues fail their probes', async () => {
    vi.spyOn(
      indicator as unknown as { getQueue: (name: string) => Queue },
      'getQueue',
    ).mockImplementation((name: string) => {
      if (name === 'webhooks') {
        return makeQueue();
      }
      // Every other queue times out.
      return {
        getJobCounts: vi.fn(() => new Promise(() => undefined)), // never resolves
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as Queue;
    });

    const report = await indicator.checkHealth();

    expect(report.status).toBe('degraded');
    expect(report.redis).toBe('up');
    const webhooks = report.queues.find((q) => q.queue === 'webhooks');
    expect(webhooks?.error).toBeUndefined();
    const timedOut = report.queues.filter((q) => q.error?.includes('timed out'));
    expect(timedOut.length).toBe(indicator.monitoredQueues.length - 1);
    expect(timedOut[0]?.connection).toBe('down');
  });

  it('reports DOWN when every queue probe fails', async () => {
    vi.spyOn(
      indicator as unknown as { getQueue: (name: string) => Queue },
      'getQueue',
    ).mockImplementation(() => {
      return {
        getJobCounts: vi.fn().mockRejectedValue(new Error('Connection is closed.')),
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as Queue;
    });

    const report = await indicator.checkHealth();

    expect(report.status).toBe('down');
    expect(report.redis).toBe('down');
    for (const q of report.queues) {
      expect(q.connection).toBe('down');
      expect(q.error).toContain('Connection is closed');
      expect(q.counts).toEqual({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 });
    }
  });

  it('probeQueue captures Redis errors per queue without throwing', async () => {
    const failing = {
      getJobCounts: vi.fn().mockRejectedValue(new Error('Redis timeout')),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Queue;
    indicator.setQueueHandle('webhooks', failing);

    const status = await indicator.probeQueue('webhooks');

    expect(status.connection).toBe('down');
    expect(status.error).toContain('Redis timeout');
    expect(status.counts.failed).toBe(0);
  });

  it('probeQueue returns normalized counts when the probe succeeds', async () => {
    const healthy = makeQueue({ failed: 7, delayed: 4, paused: 1 });
    indicator.setQueueHandle('transactions', healthy);

    const status = await indicator.probeQueue('transactions');

    expect(status.connection).toBe('up');
    expect(status.counts).toEqual({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 7,
      delayed: 4,
      paused: 1,
    });
  });

  it('probes respect the configured timeout', async () => {
    vi.useFakeTimers();
    try {
      const hanging = {
        getJobCounts: vi.fn(() => new Promise(() => undefined)),
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as Queue;
      indicator.setQueueHandle('webhooks', hanging);

      const promise = indicator.probeQueue('webhooks');
      vi.advanceTimersByTime(101);
      const status = await promise;

      expect(status.error).toContain('timed out after 100ms');
    } finally {
      vi.useRealTimers();
    }
  });
});
