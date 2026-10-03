import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiOperation, ApiTags, ApiResponse, ApiParam, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { QueueManagementService } from './queue-management.service';
import {
  ListFailedJobsFilterDto,
  listFailedJobsFilterSchema,
  BatchRetryFilterDto,
  batchRetryFilterSchema,
  BatchPurgeFilterDto,
  batchPurgeFilterSchema,
  ListFailedJobsFilterDtoSwagger,
  BatchOperationFilterDtoSwagger,
} from './queue-management.dto';
import {
  FailedJobInspection,
  BatchRetryResult,
  BatchPurgeResult,
  QueueHealthSnapshot,
} from './queue-management.service';

/**
 * Administrative Queue Management controller providing advanced DLQ
 * inspection, filtering, batch requeue, and purge endpoints.
 *
 * All endpoints are restricted to system administrators (OWNER and ADMIN roles)
 * via the `@Roles` decorator. Inputs are validated using Zod schemas piped
 * through the global ZodValidationPipe.
 *
 * This controller complements the existing DlqController by providing
 * richer filtering (time range, reason substring, job name) and batch
 * operations with granular error reporting.
 */
@ApiTags('admin-queue-management')
@ApiBearerAuth('access-token')
@Controller('admin/queues')
@Roles(UserRole.OWNER, UserRole.ADMIN)
export class QueueManagementController {
  constructor(private readonly queueManagement: QueueManagementService) {}

  // ---------------------------------------------------------------------------
  // Inspection Endpoints
  // ---------------------------------------------------------------------------

  @Get('failed')
  @ApiOperation({
    summary: 'List failed jobs with advanced filtering',
    description:
      'Returns a paginated list of failed jobs across all queues or a specific queue. ' +
      'Supports filtering by failed reason substring, job name, and time range.',
  })
  @ApiQuery({ type: ListFailedJobsFilterDtoSwagger })
  @ApiResponse({ status: 200, description: 'Paginated list of failed jobs' })
  async listFailedJobs(
    @Query(new ZodValidationPipe(listFailedJobsFilterSchema)) query: ListFailedJobsFilterDto,
  ) {
    return this.queueManagement.listFailedJobs(query);
  }

  @Get('failed/:queue/:id')
  @ApiOperation({
    summary: 'Inspect a specific failed job',
    description:
      'Returns detailed information about a specific failed job including ' +
      'payload, error details, stack trace, and derived status.',
  })
  @ApiParam({ name: 'queue', description: 'Queue to inspect', example: 'webhooks' })
  @ApiParam({ name: 'id', description: 'BullMQ job id', example: '42' })
  @ApiResponse({ status: 200, description: 'Job inspection details' })
  @ApiResponse({ status: 404, description: 'Job not found' })
  async inspectJob(
    @Param('queue') queue: string,
    @Param('id') id: string,
  ): Promise<FailedJobInspection> {
    return this.queueManagement.inspectJob(queue, id);
  }

  // ---------------------------------------------------------------------------
  // Health Endpoints
  // ---------------------------------------------------------------------------

  @Get('health')
  @ApiOperation({
    summary: 'Get queue health snapshot',
    description:
      'Returns health metrics for every registered queue including job counts, ' +
      'total processed jobs, and timestamps of oldest/newest failed jobs.',
  })
  @ApiResponse({ status: 200, description: 'Queue health metrics' })
  async getQueueHealth(): Promise<QueueHealthSnapshot[]> {
    return this.queueManagement.getQueueHealth();
  }

  // ---------------------------------------------------------------------------
  // Batch Operations
  // ---------------------------------------------------------------------------

  @Post('retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Batch retry failed jobs with filtering',
    description:
      'Retries failed jobs matching the specified filter criteria. ' +
      'Returns granular results including per-job success/failure counts.',
  })
  @ApiQuery({ type: BatchOperationFilterDtoSwagger })
  @ApiResponse({ status: 200, description: 'Batch retry results' })
  async batchRetry(
    @Query(new ZodValidationPipe(batchRetryFilterSchema)) query: BatchRetryFilterDto,
  ): Promise<BatchRetryResult> {
    return this.queueManagement.batchRetry(query);
  }

  @Post(':queue/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Batch retry failed jobs in a specific queue',
    description:
      'Retries all failed jobs in the specified queue, optionally filtered by ' +
      'reason, job name, and time range.',
  })
  @ApiParam({ name: 'queue', description: 'Target queue name', example: 'webhooks' })
  @ApiQuery({ type: BatchOperationFilterDtoSwagger })
  @ApiResponse({ status: 200, description: 'Batch retry results' })
  async batchRetryInQueue(
    @Param('queue') queue: string,
    @Query(new ZodValidationPipe(batchRetryFilterSchema)) query: BatchRetryFilterDto,
  ): Promise<BatchRetryResult> {
    return this.queueManagement.batchRetry({ ...query, queue });
  }

  @Delete('purge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Batch purge failed jobs with filtering',
    description:
      'Permanently removes failed jobs matching the specified filter criteria. ' +
      'This is a destructive operation — purged jobs cannot be recovered.',
  })
  @ApiQuery({ type: BatchOperationFilterDtoSwagger })
  @ApiResponse({
    status: 200,
    description: 'Batch purge results',
  })
  async batchPurge(
    @Query(new ZodValidationPipe(batchPurgeFilterSchema)) query: BatchPurgeFilterDto,
  ): Promise<BatchPurgeResult> {
    return this.queueManagement.batchPurge(query);
  }

  @Delete(':queue/purge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Batch purge failed jobs in a specific queue',
    description:
      'Permanently removes all failed jobs in the specified queue, optionally ' +
      'filtered by reason, job name, and time range.',
  })
  @ApiParam({ name: 'queue', description: 'Target queue name', example: 'webhooks' })
  @ApiQuery({ type: BatchOperationFilterDtoSwagger })
  @ApiResponse({
    status: 200,
    description: 'Batch purge results',
  })
  async batchPurgeInQueue(
    @Param('queue') queue: string,
    @Query(new ZodValidationPipe(batchPurgeFilterSchema)) query: BatchPurgeFilterDto,
  ): Promise<BatchPurgeResult> {
    return this.queueManagement.batchPurge({ ...query, queue });
  }
}
