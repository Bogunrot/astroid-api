import { Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags, ApiParam, ApiQuery, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { DeadLetterService } from './dead-letter.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

/**
 * Administrative dead-letter queue endpoints. Read-only inspection of captured
 * job failures plus a guarded re-drive action for remediated failures.
 * Restricted to owners/admins like the audit trail.
 */
@ApiTags('dead-letter')
@ApiBearerAuth('access-token')
@Controller('admin/dead-letter')
@Roles(UserRole.OWNER, UserRole.ADMIN)
export class DeadLetterController {
  constructor(private readonly deadLetterService: DeadLetterService) {}

  @Get()
  @ApiOperation({
    summary: 'List captured DLQ failures for the organization',
    description:
      'Returns the durable ledger entries for terminally failed background jobs, ' +
      'newest first. Optionally restricted to a single queue.',
  })
  @ApiQuery({ name: 'queue', required: false, type: String, description: 'Restrict entries to a single queue', example: 'webhooks' })
  @ApiQuery({ name: 'take', required: false, type: Number, description: 'Maximum entries to return (1-200, default 50)' })
  @ApiResponse({ status: 200, description: 'List of DLQ ledger entries for the organization' })
  list(
    @CurrentUser('organizationId') organizationId: string,
    @Query('queue') queue?: string,
    @Query('take') take?: string,
  ) {
    const limit = take ? Number(take) : undefined;
    return this.deadLetterService.listForOrganization(
      organizationId,
      queue,
      Number.isFinite(limit) ? limit : undefined,
    );
  }

  @Post(':queue/:jobId/retry')
  @ApiOperation({
    summary: 'Re-drive a failed job back onto its queue',
    description:
      'Enqueues a copy of a previously failed job so it can be retried after the ' +
      'underlying cause has been remediated. The original failure record stays intact.',
  })
  @ApiParam({ name: 'queue', description: 'Queue the failed job belongs to', example: 'webhooks' })
  @ApiParam({ name: 'jobId', description: 'BullMQ job id of the failed job', example: '42' })
  @ApiResponse({ status: 200, description: 'Re-drive accepted; returns the new job id' })
  @ApiResponse({ status: 404, description: 'Failed job not found' })
  retry(@Param('queue') queue: string, @Param('jobId') jobId: string) {
    return this.deadLetterService.requeue(queue, jobId);
  }

  @Delete(':queue/:jobId')
  @ApiOperation({
    summary: 'Purge a failed job from the queue after review',
    description: 'Permanently removes a failed job from Redis after operator review. Destructive operation.',
  })
  @ApiParam({ name: 'queue', description: 'Queue the failed job belongs to', example: 'webhooks' })
  @ApiParam({ name: 'jobId', description: 'BullMQ job id of the failed job', example: '42' })
  @ApiResponse({ status: 200, description: 'Job purged' })
  @ApiResponse({ status: 404, description: 'Failed job not found' })
  purge(@Param('queue') queue: string, @Param('jobId') jobId: string) {
    return this.deadLetterService.purge(queue, jobId);
  }
}
