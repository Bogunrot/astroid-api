import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis';
import { RedisHealthIndicator } from './redis.health';

describe('RedisHealthIndicator', () => {
  let redis: { status: string; ping: ReturnType<typeof vi.fn> };
  let indicator: RedisHealthIndicator;

  beforeEach(() => {
    redis = { status: 'ready', ping: vi.fn() };
    indicator = new RedisHealthIndicator(redis as unknown as Redis);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns UP when ping returns PONG', async () => {
    redis.ping.mockResolvedValue('PONG');

    const report = await indicator.checkHealth();

    expect(redis.ping).toHaveBeenCalledTimes(1);
    expect(report.status).toBe('up');
    expect(report.latencyMs).toBeGreaterThanOrEqual(0);
    expect(report.error).toBeUndefined();
  });

  it('returns DOWN when ping fails', async () => {
    redis.ping.mockRejectedValue(new Error('Redis connection refused'));

    const report = await indicator.checkHealth();

    expect(report.status).toBe('down');
    expect(report.error).toContain('Redis connection refused');
  });

  it('returns DOWN on an unexpected ping reply', async () => {
    redis.ping.mockResolvedValue('LOADING');

    const report = await indicator.checkHealth();

    expect(report.status).toBe('down');
    expect(report.error).toContain('Unexpected ping response');
  });

  it('returns DOWN without pinging when the client connection has ended', async () => {
    redis.status = 'end';

    const report = await indicator.checkHealth();

    expect(redis.ping).not.toHaveBeenCalled();
    expect(report.status).toBe('down');
    expect(report.error).toContain('closed');
  });

  it('returns DOWN once the probe exceeds its timeout', async () => {
    vi.useFakeTimers();
    // Simulates ioredis holding the command in its offline queue while Redis is
    // unreachable: the promise never settles on its own.
    redis.ping.mockReturnValue(new Promise(() => undefined));

    const pending = indicator.checkHealth(500);
    await vi.advanceTimersByTimeAsync(500);
    const report = await pending;

    expect(report.status).toBe('down');
    expect(report.error).toContain('timed out after 500ms');
  });
});
