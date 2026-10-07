import { z } from 'zod';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Zod schema for the time-range filter used in failed job queries.
 */
export const timeRangeFilterSchema = z
  .object({
    from: z.coerce.number().int().nonnegative().optional(),
    to: z.coerce.number().int().nonnegative().optional(),
  })
  .optional();

export type TimeRangeFilterDto = z.infer<typeof timeRangeFilterSchema>;

/**
 * Zod schema for listing failed jobs with advanced filtering.
 */
export const listFailedJobsFilterSchema = z.object({
  /** Target queue name. If omitted, queries all registered queues. */
  queue: z.string().optional(),
  /** Filter by failed reason containing this substring (case-insensitive). */
  reasonContains: z.string().max(200).optional(),
  /** Filter by BullMQ job name. */
  jobName: z.string().max(200).optional(),
  /** Filter by time range (epoch ms). */
  timeRange: timeRangeFilterSchema,
  /** Page number (1-indexed). */
  page: z.coerce.number().int().positive().default(1),
  /** Items per page (max 100). */
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export type ListFailedJobsFilterDto = z.infer<typeof listFailedJobsFilterSchema>;

/**
 * Zod schema for batch retry requests. Uses the same filter as listing,
 * but with a higher default limit.
 */
export const batchRetryFilterSchema = z.object({
  queue: z.string().optional(),
  reasonContains: z.string().max(200).optional(),
  jobName: z.string().max(200).optional(),
  timeRange: timeRangeFilterSchema,
  limit: z.coerce.number().int().positive().max(10_000).default(1000),
});

export type BatchRetryFilterDto = z.infer<typeof batchRetryFilterSchema>;

/**
 * Zod schema for batch purge requests.
 */
export const batchPurgeFilterSchema = z.object({
  queue: z.string().optional(),
  reasonContains: z.string().max(200).optional(),
  jobName: z.string().max(200).optional(),
  timeRange: timeRangeFilterSchema,
  limit: z.coerce.number().int().positive().max(10_000).default(1000),
});

export type BatchPurgeFilterDto = z.infer<typeof batchPurgeFilterSchema>;

/**
 * Zod schema for inspecting a specific job.
 */
export const inspectJobParamsSchema = z.object({
  queue: z.string().min(1, 'Queue name is required'),
  id: z.string().min(1, 'Job ID is required'),
});

export type InspectJobParamsDto = z.infer<typeof inspectJobParamsSchema>;

// ── Swagger DTOs ──

/** Swagger model mirroring {@link ListFailedJobsFilterDto}. */
export class ListFailedJobsFilterDtoSwagger {
  @ApiPropertyOptional({ description: 'Restrict results to a single queue; omit to query all queues', example: 'webhooks' })
  queue?: string;

  @ApiPropertyOptional({ description: 'Failed-reason substring filter (case-insensitive)', example: 'HTTP 503' })
  reasonContains?: string;

  @ApiPropertyOptional({ description: 'Exact BullMQ job name filter', example: 'webhook-delivery' })
  jobName?: string;

  @ApiPropertyOptional({ type: Object, description: 'Time range filter in epoch ms: { from?, to? }' })
  timeRange?: { from?: number; to?: number };

  @ApiPropertyOptional({ description: 'Page number (1-indexed)', default: 1, example: 1 })
  page?: number;

  @ApiPropertyOptional({ description: 'Items per page (max 100)', default: 20, example: 20 })
  limit?: number;
}

/** Swagger model mirroring {@link BatchRetryFilterDto} / {@link BatchPurgeFilterDto}. */
export class BatchOperationFilterDtoSwagger {
  @ApiPropertyOptional({ description: 'Restrict the operation to a single queue; omit to target all queues', example: 'webhooks' })
  queue?: string;

  @ApiPropertyOptional({ description: 'Failed-reason substring filter (case-insensitive)', example: 'timeout' })
  reasonContains?: string;

  @ApiPropertyOptional({ description: 'Exact BullMQ job name filter', example: 'deliver-webhook' })
  jobName?: string;

  @ApiPropertyOptional({ type: Object, description: 'Time range filter in epoch ms: { from?, to? }' })
  timeRange?: { from?: number; to?: number };

  @ApiPropertyOptional({ description: 'Maximum number of jobs to process in this invocation', default: 1000, example: 1000 })
  limit?: number;
}
