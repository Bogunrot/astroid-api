import { z } from 'zod';
import { ApiPropertyOptional } from '@nestjs/swagger';

const exportFilters = {
  agentId: z.string().optional(),
  userId: z.string().optional(),
  actionType: z.string().optional(),
  /** Matches a severity value stored in oldValue or newValue JSON metadata. */
  severity: z.enum(['info', 'warning', 'error', 'critical']).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
};

function validateDateRange(
  value: { startDate?: string; endDate?: string },
  context: z.RefinementCtx,
) {
  if (value.startDate && value.endDate && Date.parse(value.startDate) > Date.parse(value.endDate)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endDate'],
      message: 'endDate must be on or after startDate',
    });
  }
}

export const exportAuditLogsQuerySchema = z
  .object({
    ...exportFilters,
    limit: z.coerce.number().int().positive().max(1000).default(100),
    cursor: z.string().optional(),
    format: z.enum(['json', 'csv']).default('json'),
  })
  .superRefine(validateDateRange);

/** Filters and pagination options accepted by the audit log page export. */
export type ExportAuditLogsQuery = z.infer<typeof exportAuditLogsQuerySchema>;

/** Strict query contract for the batch-streamed audit export endpoint. */
export const streamAuditLogsQuerySchema = z
  .object({
    ...exportFilters,
    cursor: z.string().optional(),
    batchSize: z.coerce.number().int().positive().max(1000).default(250),
    format: z.enum(['json', 'csv']).default('json'),
  })
  .strict()
  .superRefine(validateDateRange);

/** Parsed query options for streaming an audit log export. */
export type StreamAuditLogsQuery = z.infer<typeof streamAuditLogsQuerySchema>;

/** Swagger model mirroring {@link ExportAuditLogsQuery}. */
export class ExportAuditLogsQueryDto {
  @ApiPropertyOptional({ description: 'Filter by agent UUID' })
  agentId?: string;

  @ApiPropertyOptional({ description: 'Filter by user UUID' })
  userId?: string;

  @ApiPropertyOptional({ description: 'Filter by audit action type', example: 'wallet.created' })
  actionType?: string;

  @ApiPropertyOptional({
    enum: ['info', 'warning', 'error', 'critical'],
    description: 'Filter by severity stored in oldValue or newValue metadata',
  })
  severity?: 'info' | 'warning' | 'error' | 'critical';

  @ApiPropertyOptional({
    description: 'ISO 8601 start of the export window',
    example: '2026-01-01T00:00:00.000Z',
  })
  startDate?: string;

  @ApiPropertyOptional({
    description: 'ISO 8601 end of the export window',
    example: '2026-12-31T23:59:59.000Z',
  })
  endDate?: string;

  @ApiPropertyOptional({
    description: 'Maximum entries to export (max 1000)',
    default: 100,
    example: 100,
  })
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque pagination cursor from a previous page' })
  cursor?: string;

  @ApiPropertyOptional({
    enum: ['json', 'csv'],
    description: 'Export format (default json)',
    default: 'json',
  })
  format?: 'json' | 'csv';
}

/** Swagger model mirroring {@link StreamAuditLogsQuery}. */
export class StreamAuditLogsQueryDto extends ExportAuditLogsQueryDto {
  @ApiPropertyOptional({
    description: 'Number of rows fetched per database batch (max 1000)',
    default: 250,
  })
  batchSize?: number;
}
