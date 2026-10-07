import { Logger } from '@nestjs/common';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createQueryMetricsExtension } from './query-metrics.extension';

describe('createQueryMetricsExtension', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('passes fast queries through without logging', async () => {
    const ext = createQueryMetricsExtension({ slowQueryThresholdMs: 5000 });
    const fastQuery = vi.fn().mockResolvedValue([{ id: '1' }]);

    const result = await ext.query.$allOperations({
      operation: 'findMany',
      model: 'User',
      args: {},
      query: fastQuery,
    });

    expect(result).toEqual([{ id: '1' }]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('emits a structured slow_query warning when the threshold is exceeded', async () => {
    const ext = createQueryMetricsExtension({ slowQueryThresholdMs: 5 });
    const slowQuery = () =>
      new Promise((resolve) => setTimeout(() => resolve('ok'), 50));

    await ext.query.$allOperations({
      operation: 'findMany',
      model: 'Transaction',
      args: {},
      query: slowQuery as (args: unknown) => Promise<unknown>,
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const record = JSON.parse(String(warnSpy.mock.calls[0][0]));
    expect(record).toMatchObject({
      event: 'slow_query',
      operation: 'findMany',
      model: 'Transaction',
      thresholdMs: 5,
    });
    expect(record.durationMs).toBeGreaterThanOrEqual(5);
  });

  it('still emits the warning when a slow query also rejects', async () => {
    const ext = createQueryMetricsExtension({ slowQueryThresholdMs: 5 });
    const boom = new Error('connection lost');
    const slowFailing = () =>
      new Promise<unknown>((_, reject) => setTimeout(() => reject(boom), 50));

    await expect(
      ext.query.$allOperations({
        operation: 'create',
        model: 'Wallet',
        args: {},
        query: slowFailing as (args: unknown) => Promise<unknown>,
      }),
    ).rejects.toBe(boom);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const record = JSON.parse(String(warnSpy.mock.calls[0][0]));
    expect(record).toMatchObject({ event: 'slow_query', error: 'connection lost' });
  });

  it('is a no-op when slowQueryThresholdMs is 0', async () => {
    const ext = createQueryMetricsExtension({ slowQueryThresholdMs: 0 });
    const query = vi.fn().mockResolvedValue('result');

    const result = await ext.query.$allOperations({
      operation: 'findUnique',
      model: 'User',
      args: { where: { id: '1' } },
      query,
    });

    expect(result).toBe('result');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('propagates errors from fast failing queries without logging', async () => {
    const ext = createQueryMetricsExtension({ slowQueryThresholdMs: 5000 });
    const boom = new Error('unique constraint');
    const fastFailing = () => Promise.reject(boom);

    await expect(
      ext.query.$allOperations({
        operation: 'create',
        model: 'Organization',
        args: {},
        query: fastFailing as (args: unknown) => Promise<unknown>,
      }),
    ).rejects.toBe(boom);

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
