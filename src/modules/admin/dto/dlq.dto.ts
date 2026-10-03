import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Query parameters for listing failed / dead-letter jobs. */
export const listDlqJobsQuerySchema = z.object({
  /** Target queue name filter. If omitted, queries across all registered queues. */
  queue: z.string().optional(),
  /** Page number for pagination (1-indexed). */
  page: z.coerce.number().int().positive().default(1),
  /** Number of items per page. */
  limit: z.coerce.number().int().positive().max(100).default(20),
  /** Zero-based start index (overrides page/limit if provided). */
  start: z.coerce.number().int().nonnegative().optional(),
  /** Zero-based end index (overrides page/limit if provided). */
  end: z.coerce.number().int().nonnegative().optional(),
});

export type ListDlqJobsQuery = z.infer<typeof listDlqJobsQuerySchema>;

/** Payload for retrying failed jobs. */
export const retryJobDtoSchema = z.object({
  /** Queue name if not supplied in path parameter. */
  queue: z.string().optional(),
});

export type RetryJobDto = z.infer<typeof retryJobDtoSchema>;

/** Payload for purging obsolete failed jobs. */
export const purgeDlqSchema = z.object({
  /** Queue name to purge. If omitted, purges across all queues. */
  queue: z.string().optional(),
  /** Grace period in milliseconds. Jobs failed more recently than this are kept. Defaults to 0 (purge all). */
  gracePeriodMs: z.coerce.number().int().nonnegative().default(0),
  /** Maximum number of jobs to purge in this invocation. Defaults to 1000. */
  limit: z.coerce.number().int().positive().max(10000).default(1000),
});

export type PurgeDlqDto = z.infer<typeof purgeDlqSchema>;

/** Detailed representation of a failed / DLQ job. */
export interface DlqJobDetails {
  id: string;
  name: string;
  queue: string;
  data: unknown;
  opts: Record<string, unknown>;
  failedReason?: string;
  stacktrace?: string[];
  attemptsMade: number;
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
  returnvalue?: unknown;
}

/** Queue summary statistics. */
export interface QueueJobCounts {
  queue: string;
  failed: number;
  active: number;
  waiting: number;
  delayed: number;
  completed: number;
  paused: number;
}

// ── Swagger DTOs ──

/** Swagger model mirroring {@link ListDlqJobsQuery}. */
export class ListDlqJobsQueryDto {
  @ApiPropertyOptional({ description: 'Restrict results to a single queue; omit to query all queues', example: 'webhooks' })
  queue?: string;

  @ApiPropertyOptional({ description: 'Page number (1-indexed)', default: 1, example: 1 })
  page?: number;

  @ApiPropertyOptional({ description: 'Items per page (max 100)', default: 20, example: 20 })
  limit?: number;

  @ApiPropertyOptional({ description: 'Zero-based start index; overrides page/limit when provided' })
  start?: number;

  @ApiPropertyOptional({ description: 'Zero-based end index; overrides page/limit when provided' })
  end?: number;
}

/** Swagger model mirroring {@link PurgeDlqDto}. */
export class PurgeDlqSwaggerDto {
  @ApiPropertyOptional({ description: 'Queue to purge; omit to purge across all queues', example: 'webhooks' })
  queue?: string;

  @ApiPropertyOptional({
    description: 'Grace period in ms — jobs failed more recently than this are kept',
    default: 0,
    example: 0,
  })
  gracePeriodMs?: number;

  @ApiPropertyOptional({ description: 'Maximum number of jobs to purge in this invocation', default: 1000, example: 1000 })
  limit?: number;
}

/** Swagger model mirroring {@link DlqJobDetails}. */
export class DlqJobDetailsDto {
  @ApiProperty({ description: 'BullMQ job id', example: '42' })
  id!: string;

  @ApiProperty({ description: 'BullMQ job name', example: 'webhook-delivery' })
  name!: string;

  @ApiProperty({ description: 'Queue the job belongs to', example: 'dead-letter' })
  queue!: string;

  @ApiProperty({ description: 'Original enqueued payload of the failed job' })
  data!: unknown;

  @ApiProperty({ description: 'BullMQ job options (attempts, backoff, removeOn…)', type: Object })
  opts!: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Terminal failure reason reported by the worker' })
  failedReason?: string;

  @ApiPropertyOptional({ type: [String], description: 'Worker stack trace captured at failure time' })
  stacktrace?: string[];

  @ApiProperty({ description: 'Attempts consumed before the failure', example: 3 })
  attemptsMade!: number;

  @ApiProperty({
    type: Number,
    format: 'int64',
    description: 'Job creation timestamp (epoch ms)',
    example: 1725050000000,
  })
  timestamp!: number;

  @ApiPropertyOptional({ type: Number, format: 'int64', description: 'Last processing start timestamp (epoch ms)' })
  processedOn?: number;

  @ApiPropertyOptional({ type: Number, format: 'int64', description: 'Failure timestamp (epoch ms)' })
  finishedOn?: number;

  @ApiPropertyOptional({ description: 'Return value recorded by the processor, if any' })
  returnvalue?: unknown;
}

/** Swagger model for the paginated failed-jobs list response. */
export class PaginatedDlqJobsDto {
  @ApiProperty({ type: [DlqJobDetailsDto], description: 'Failed / dead-lettered jobs' })
  items!: DlqJobDetailsDto[];

  @ApiProperty({ description: 'Total failed jobs across the queried scope', example: 12 })
  total!: number;

  @ApiProperty({ description: 'Current page number (1-indexed)', example: 1 })
  page!: number;

  @ApiProperty({ description: 'Items per page', example: 20 })
  limit!: number;
}

/** Swagger model for a single-job retry result. */
export class RetryJobResultDto {
  @ApiProperty({ description: 'BullMQ job id that was retried', example: '42' })
  jobId!: string;

  @ApiProperty({ description: 'Queue the job was retried on', example: 'webhooks' })
  queue!: string;

  @ApiProperty({ description: 'Whether the retry was accepted', example: true })
  retried!: boolean;

  @ApiProperty({
    description: 'Human-readable confirmation',
    example: "Job '42' successfully moved from failed back to waiting queue.",
  })
  message!: string;
}

/** Swagger model for a batch retry-all result. */
export class RetryAllResultDto {
  @ApiProperty({ description: 'Number of jobs moved back onto their waiting lists', example: 5 })
  retriedCount!: number;

  @ApiProperty({ type: [String], description: 'Queues affected by the batch retry', example: ['webhooks'] })
  queues!: string[];
}

/** Swagger model for a job removal result. */
export class RemoveJobResultDto {
  @ApiProperty({ description: 'BullMQ job id that was removed', example: '42' })
  jobId!: string;

  @ApiProperty({ description: 'Queue the job was removed from', example: 'webhooks' })
  queue!: string;

  @ApiProperty({ description: 'Whether the removal succeeded', example: true })
  removed!: boolean;
}

/** Swagger model for a purge result. */
export class PurgeResultDto {
  @ApiProperty({ description: 'Number of jobs purged in this invocation', example: 10 })
  purgedCount!: number;

  @ApiProperty({ type: [String], description: 'Ids of the purged jobs', example: ['42', '43'] })
  removedJobIds!: string[];

  @ApiProperty({ type: [String], description: 'Queues affected by the purge', example: ['webhooks'] })
  queues!: string[];
}

/** Swagger model mirroring {@link QueueJobCounts}. */
export class QueueJobCountsDto {
  @ApiProperty({ description: 'Queue name', example: 'webhooks' })
  queue!: string;

  @ApiProperty({ description: 'Jobs in the failed state', example: 2 })
  failed!: number;

  @ApiProperty({ description: 'Jobs currently being processed', example: 1 })
  active!: number;

  @ApiProperty({ description: 'Jobs waiting to be processed', example: 5 })
  waiting!: number;

  @ApiProperty({ description: 'Delayed jobs waiting for their scheduled time', example: 0 })
  delayed!: number;

  @ApiProperty({ description: 'Successfully completed jobs', example: 120 })
  completed!: number;

  @ApiProperty({ description: 'Paused jobs', example: 0 })
  paused!: number;
}
