import { Logger } from '@nestjs/common';

const logger = new Logger('QueryMetrics');

export interface QueryMetricsOptions {
  /**
   * Queries that take longer than this threshold will emit a warn log.
   * Set to 0 to disable slow query logging.
   */
  slowQueryThresholdMs: number;
}

/**
 * Prisma client extension that records slow query warnings. Any query whose
 * wall time exceeds `slowQueryThresholdMs` produces a structured warn log on
 * the `QueryMetrics` logger. The extension adds no latency on the hot path
 * when `slowQueryThresholdMs` is 0.
 */
export function createQueryMetricsExtension(options: QueryMetricsOptions) {
  const { slowQueryThresholdMs } = options;

  return {
    query: {
      $allOperations({
        operation,
        model,
        args,
        query,
      }: {
        operation: string;
        model?: string;
        args: unknown;
        query: (args: unknown) => Promise<unknown>;
      }) {
        if (slowQueryThresholdMs === 0) {
          return query(args);
        }

        const startedAt = Date.now();

        const record = (durationMs: number, error?: unknown) => {
          if (durationMs < slowQueryThresholdMs) return;
          logger.warn(
            JSON.stringify({
              event: 'slow_query',
              operation,
              model,
              durationMs,
              thresholdMs: slowQueryThresholdMs,
              ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
            }),
          );
        };

        return query(args).then(
          (result) => {
            record(Date.now() - startedAt);
            return result;
          },
          (error: unknown) => {
            record(Date.now() - startedAt, error);
            throw error;
          },
        );
      },
    },
  };
}
