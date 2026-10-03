import { beforeEach, describe, expect, it, vi } from 'vitest';

const getJobCounts = vi.fn();
const close = vi.fn();

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation((name: string) => ({
    name,
    getJobCounts,
    close,
  })),
}));

vi.mock('../../config/redis.config', () => ({
  redisConfig: () => ({ host: 'localhost', port: 6379, password: '', db: 0 }),
}));

import { MetricsService } from './metrics.service';
import { PrismaService } from '../../database/prisma.service';

describe('MetricsService', () => {
  let service: MetricsService;
  let getPoolStats: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    getJobCounts.mockResolvedValue({
      waiting: 3,
      active: 1,
      completed: 100,
      failed: 2,
      delayed: 0,
      paused: 0,
    });
    getPoolStats = vi.fn().mockResolvedValue({ active: 2, idle: 5, waiting: 0 });
    service = new MetricsService({ getPoolStats } as unknown as PrismaService);
  });

  it('exposes the Prometheus content type', () => {
    expect(service.contentType).toContain('text/plain');
  });

  it('records HTTP request duration and count', async () => {
    service.observeHttpRequest('GET', '/v1/agents/:id', 200, 0.042);

    const output = await service.getMetrics();

    expect(output).toContain('http_requests_total');
    expect(output).toContain('method="GET"');
    expect(output).toContain('route="/v1/agents/:id"');
    expect(output).toContain('status_code="200"');
    expect(output).toContain('http_request_duration_seconds');
  });

  it('accumulates counts across multiple requests with the same labels', async () => {
    service.observeHttpRequest('POST', '/v1/transactions', 201, 0.01);
    service.observeHttpRequest('POST', '/v1/transactions', 201, 0.02);

    const output = await service.getMetrics();
    const match = output.match(
      /http_requests_total\{method="POST",route="\/v1\/transactions",status_code="201"\} (\d+)/,
    );

    expect(match).not.toBeNull();
    expect(match?.[1]).toBe('2');
  });

  it('samples BullMQ job counts per queue into the queue depth gauge', async () => {
    const output = await service.getMetrics();

    expect(getJobCounts).toHaveBeenCalled();
    expect(output).toContain('bullmq_queue_jobs');
    expect(output).toMatch(/bullmq_queue_jobs\{queue="webhooks",state="waiting"\} 3/);
    expect(output).toMatch(/bullmq_queue_jobs\{queue="webhooks",state="failed"\} 2/);
  });

  it('does not throw when a queue fails to report job counts', async () => {
    getJobCounts.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(service.getMetrics()).resolves.toEqual(expect.any(String));
  });

  it('closes all queue handles on module destroy', async () => {
    await service.onModuleDestroy();

    expect(close).toHaveBeenCalled();
  });

  it('samples active/idle/waiting connection counts into the pool gauge', async () => {
    const output = await service.getMetrics();

    expect(getPoolStats).toHaveBeenCalled();
    expect(output).toContain('db_pool_connections');
    expect(output).toMatch(/db_pool_connections\{state="active"\} 2/);
    expect(output).toMatch(/db_pool_connections\{state="idle"\} 5/);
    expect(output).toMatch(/db_pool_connections\{state="waiting"\} 0/);
  });

  describe('worker job metrics', () => {
    it('records successful job completion in the duration histogram', async () => {
      service.recordJobCompletion('webhooks', 'deliver', 0.25, 'success');

      const output = await service.getMetrics();

      expect(output).toContain('worker_job_duration_seconds');
      expect(output).toContain('queue="webhooks"');
      expect(output).toContain('job_name="deliver"');
      expect(output).toContain('result="success"');
    });

    it('records failed job completion', async () => {
      service.recordJobCompletion('transactions', 'execute', 1.5, 'failure');

      const output = await service.getMetrics();

      expect(output).toContain('worker_jobs_total');
      expect(output).toContain('queue="transactions"');
      expect(output).toContain('job_name="execute"');
      expect(output).toContain('result="failure"');
    });

    it('increments job counter across multiple completions', async () => {
      service.recordJobCompletion('webhooks', 'deliver', 0.1, 'success');
      service.recordJobCompletion('webhooks', 'deliver', 0.2, 'success');

      const output = await service.getMetrics();
      const match = output.match(
        /worker_jobs_total\{queue="webhooks",job_name="deliver",result="success"\} (\d+)/,
      );

      expect(match).not.toBeNull();
      expect(match?.[1]).toBe('2');
    });
  });
});
