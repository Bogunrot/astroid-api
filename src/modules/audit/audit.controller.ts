import { Controller, Get, Param, Query, Res, StreamableFile } from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiBearerAuth,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiProduces,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Response } from 'express';
import { AuditService } from './audit.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuditListQuery, auditListQuerySchema } from './audit-list.dto';
import {
  ExportAuditLogsQuery,
  exportAuditLogsQuerySchema,
  ExportAuditLogsQueryDto,
  StreamAuditLogsQuery,
  StreamAuditLogsQueryDto,
  streamAuditLogsQuerySchema,
} from './audit-export.dto';

/** Read-only access to the append-only audit trail. Restricted to auditors/admins. */
@ApiTags('audit')
@ApiBearerAuth('access-token')
@Controller('audit')
@Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.AUDITOR)
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get('export')
  @ApiOperation({
    summary: 'Export audit log entries for compliance reporting',
    description:
      'Exports audit log entries in CSV or JSON format. Supports filtering by action, date range, and agent.',
  })
  @ApiQuery({ type: ExportAuditLogsQueryDto })
  @ApiProduces('text/csv', 'application/json')
  @ApiResponse({ status: 200, description: 'Audit log export (CSV or JSON)' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions (requires OWNER, ADMIN, or AUDITOR)' })
  async export(
    @CurrentUser('organizationId') organizationId: string,
    @Query(new ZodValidationPipe(exportAuditLogsQuerySchema)) query: ExportAuditLogsQuery,
    @Res() res: Response,
  ) {
    const result = await this.auditService.export(organizationId, query);

    if (result.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="audit-logs-${organizationId}-${Date.now()}.csv"`,
      );
      return res.status(200).send(result.data);
    }

    return res.status(200).json({
      success: true,
      data: result.data,
      meta: {
        count: result.count,
        nextCursor: result.nextCursor,
      },
    });
  }

  @Get('export/stream')
  @ApiOperation({
    summary: 'Stream an audit log export in bounded database batches',
    description:
      'Streams JSON or CSV rows without buffering the complete export. Sensitive keys in oldValue and newValue are redacted.',
  })
  @ApiQuery({ type: StreamAuditLogsQueryDto })
  @ApiProduces('text/csv', 'application/json')
  @ApiResponse({ status: 200, description: 'Streamed audit log export' })
  @ApiResponse({ status: 400, description: 'Invalid export filters' })
  streamExport(
    @CurrentUser('organizationId') organizationId: string,
    @Query(new ZodValidationPipe(streamAuditLogsQuerySchema)) query: StreamAuditLogsQuery,
  ): StreamableFile {
    const extension = query.format === 'csv' ? 'csv' : 'json';
    const contentType = query.format === 'csv' ? 'text/csv' : 'application/json';
    return new StreamableFile(this.auditService.streamExport(organizationId, query), {
      type: contentType,
      disposition: `attachment; filename="audit-logs-${organizationId}-${Date.now()}.${extension}"`,
    });
  }

  @Get()
  @ApiOperation({
    summary: 'List audit log entries for the organization',
    description:
      'Returns a paginated list of audit log entries. Supports filtering by action, date range, and agent.',
  })
  @ApiQuery({ name: 'cursor', required: false, type: String, description: 'Opaque cursor returned by the previous page' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 20, max: 100)' })
  @ApiQuery({ name: 'actorId', required: false, type: String, description: 'Filter by actor user ID' })
  @ApiQuery({ name: 'action', required: false, type: String, description: 'Filter by audit action type' })
  @ApiQuery({ name: 'resourceId', required: false, type: String, description: 'Filter by resource identifier' })
  @ApiQuery({ name: 'from', required: false, type: String, description: 'Inclusive ISO 8601 start time' })
  @ApiQuery({ name: 'to', required: false, type: String, description: 'Inclusive ISO 8601 end time' })
  @ApiResponse({ status: 200, description: 'Paginated list of audit log entries' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  list(
    @CurrentUser('organizationId') organizationId: string,
    @Query(new ZodValidationPipe(auditListQuerySchema)) query: AuditListQuery,
  ) {
    return this.auditService.list(organizationId, query);
  }

  @Get('integrity/verify')
  @ApiOperation({
    summary: 'Verify the integrity of the entire audit chain',
    description:
      'Performs a cryptographic verification of the entire audit chain to detect any tampering. ' +
      'This operation may be slow for large audit logs.',
  })
  @ApiResponse({ status: 200, description: 'Integrity verification result (valid/invalid with details)' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  verifyIntegrity(@CurrentUser('organizationId') organizationId: string) {
    return this.auditService.verifyIntegrity(organizationId);
  }

  @Get('integrity/:id')
  @ApiOperation({
    summary: 'Verify the integrity of a single audit log entry',
    description:
      'Verifies that a specific audit log entry has not been tampered with by checking its cryptographic hash.',
  })
  @ApiParam({ name: 'id', description: 'Audit log entry UUID', example: '018f0a1b-...' })
  @ApiResponse({ status: 200, description: 'Entry integrity verification result' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Audit log entry not found' })
  verifyEntryIntegrity(
    @CurrentUser('organizationId') organizationId: string,
    @Param('id') id: string,
  ) {
    return this.auditService.verifyEntryIntegrity(id, organizationId);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a single audit log entry',
    description: 'Returns full details of a single audit log entry by ID.',
  })
  @ApiParam({ name: 'id', description: 'Audit log entry UUID', example: '018f0a1b-...' })
  @ApiResponse({ status: 200, description: 'Audit log entry details' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Audit log entry not found' })
  findOne(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.auditService.findById(organizationId, id);
  }
}
