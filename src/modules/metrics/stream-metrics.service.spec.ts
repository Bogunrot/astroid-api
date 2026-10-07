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
import { StreamMetricsService } from './stream-metrics.service';
import { PrismaService } from '../../database/prisma.service';

describe('StreamMetricsService', () => {
  let metricsService: MetricsService;
  let service: StreamMetricsService;

  beforeEach(() => {
    vi.clearAllMocks();
    getJobCounts.mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 });
    const getPoolStats = vi.fn().mockResolvedValue({ active: 0, idle: 0, waiting: 0 });
    metricsService = new MetricsService({ getPoolStats } as unknown as PrismaService);
    service = new StreamMetricsService(metricsService);
  });

  it('returns a zeroed snapshot for a stream with no samples', () => {
    expect(service.getSnapshot('unknown-stream')).toEqual({ p95: 0, p99: 0, sampleCount: 0 });
  });

  it('computes p95/p99 accurately across a known distribution', () => {
    for (let i = 1; i <= 100; i++) {
      service.record('ingest', i);
    }

    const snapshot = service.getSnapshot('ingest');
    expect(snapshot.sampleCount).toBe(100);
    expect(snapshot.p95).toBe(95);
    expect(snapshot.p99).toBe(99);
  });

  it('keeps a bounded sliding window by overwriting the oldest samples', () => {
    for (let i = 1; i <= 1000; i++) {
      service.record('bounded', i);
    }
    // Push 500 more samples past the 1000-capacity window.
    for (let i = 1001; i <= 1500; i++) {
      service.record('bounded', i);
    }

    const snapshot = service.getSnapshot('bounded');
    expect(snapshot.sampleCount).toBe(1000);
    // Window should now only contain samples 501..1500.
    expect(snapshot.p99).toBeGreaterThanOrEqual(1485);
  });

  it('tracks separate windows per stream independently', () => {
    for (let i = 1; i <= 50; i++) service.record('stream-a', i);
    for (let i = 1; i <= 50; i++) service.record('stream-b', i * 10);

    const a = service.getSnapshot('stream-a');
    const b = service.getSnapshot('stream-b');
    expect(a.p95).toBeLessThan(b.p95);
  });

  it('remains correct under interleaved concurrent-style writes to multiple streams', async () => {
    const streams = ['s1', 's2', 's3'];
    await Promise.all(
      streams.map(async (stream, idx) => {
        for (let i = 1; i <= 200; i++) {
          service.record(stream, i + idx * 1000);
          // yield to the event loop to interleave with other streams' writes
          if (i % 10 === 0) await Promise.resolve();
        }
      }),
    );

    for (const stream of streams) {
      const snapshot = service.getSnapshot(stream);
      expect(snapshot.sampleCount).toBe(200);
    }
  });

  it('exposes p95/p99 gauges through the shared Prometheus registry', async () => {
    service.record('scraped', 10);
    service.record('scraped', 20);

    const output = await metricsService.getMetrics();
    expect(output).toContain('stream_collection_latency_p95_ms');
    expect(output).toContain('stream_collection_latency_p99_ms');
    expect(output).toContain('stream="scraped"');
  });
});
