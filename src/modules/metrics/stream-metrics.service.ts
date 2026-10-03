import { Injectable } from '@nestjs/common';
import { Gauge } from 'prom-client';
import { MetricsService } from './metrics.service';

/**
 * Fixed-size ring buffer of recent latency samples (milliseconds) for a
 * single stream. Old samples are overwritten once the buffer fills, giving
 * a bounded-memory sliding window without any locking: all operations are
 * synchronous, and Node's single-threaded event loop makes each call
 * atomic with respect to other stream events.
 */
class LatencyRingBuffer {
  private readonly samples: Float64Array;
  private writeIndex = 0;
  private filled = false;

  constructor(private readonly capacity: number) {
    this.samples = new Float64Array(capacity);
  }

  record(latencyMs: number): void {
    this.samples[this.writeIndex] = latencyMs;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.writeIndex === 0) {
      this.filled = true;
    }
  }

  size(): number {
    return this.filled ? this.capacity : this.writeIndex;
  }

  /** Returns the requested percentile (0-100) over the current window, or 0 if empty. */
  percentile(p: number): number {
    const count = this.size();
    if (count === 0) return 0;
    const sorted = Array.from(this.samples.slice(0, count)).sort((a, b) => a - b);
    const rank = Math.min(count - 1, Math.ceil((p / 100) * count) - 1);
    return sorted[Math.max(0, rank)];
  }
}

/**
 * Sliding-window latency aggregation for high-frequency stream collection
 * events, exposing p95/p99 percentile breakdowns per stream for latency
 * bottleneck analysis. Backed by a fixed-size ring buffer per stream key
 * so throughput is unaffected regardless of event volume — no blocking
 * locks, no unbounded memory growth.
 */
@Injectable()
export class StreamMetricsService {
  private readonly buffers = new Map<string, LatencyRingBuffer>();
  private static readonly WINDOW_SAMPLE_CAPACITY = 1000;

  private readonly p95Gauge: Gauge<string>;
  private readonly p99Gauge: Gauge<string>;

  constructor(metricsService: MetricsService) {
    const registry = metricsService.promRegistry;
    this.p95Gauge = new Gauge({
      name: 'stream_collection_latency_p95_ms',
      help: 'p95 latency (ms) of stream collection events over the recent sliding window',
      labelNames: ['stream'],
      registers: [registry],
    });
    this.p99Gauge = new Gauge({
      name: 'stream_collection_latency_p99_ms',
      help: 'p99 latency (ms) of stream collection events over the recent sliding window',
      labelNames: ['stream'],
      registers: [registry],
    });
  }

  /** Records a single stream event's processing latency in milliseconds. */
  record(stream: string, latencyMs: number): void {
    let buffer = this.buffers.get(stream);
    if (!buffer) {
      buffer = new LatencyRingBuffer(StreamMetricsService.WINDOW_SAMPLE_CAPACITY);
      this.buffers.set(stream, buffer);
    }
    buffer.record(latencyMs);
    this.p95Gauge.set({ stream }, buffer.percentile(95));
    this.p99Gauge.set({ stream }, buffer.percentile(99));
  }

  /** Returns the current p95/p99 snapshot for a stream, for internal use/tests. */
  getSnapshot(stream: string): { p95: number; p99: number; sampleCount: number } {
    const buffer = this.buffers.get(stream);
    if (!buffer) return { p95: 0, p99: 0, sampleCount: 0 };
    return { p95: buffer.percentile(95), p99: buffer.percentile(99), sampleCount: buffer.size() };
  }
}
