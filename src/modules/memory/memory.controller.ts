import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiBearerAuth,
  ApiResponse,
  ApiParam,
  ApiBody,
  ApiQuery,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { MemoryService } from './memory.service';
import { createMemorySchema, CreateMemoryInput, CreateMemoryDto } from './memory.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PaginationQuery, paginationQuerySchema } from '../../common/helpers/pagination';
import { ApiPaginationQuery } from '../../common/decorators/api-pagination-query.decorator';

@ApiTags('memory')
@ApiBearerAuth('access-token')
@Controller('memory')
export class MemoryController {
  constructor(private readonly memoryService: MemoryService) {}

  @Get()
  @ApiOperation({
    summary: 'Search the financial memory (task/reason/summary)',
    description:
      'Returns a paginated list of memory records for the current organization. ' +
      'Memory records capture agent decisions, reasoning, and outcomes for audit and learning.',
  })
  @ApiPaginationQuery()
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Full-text search across task, reason, and summary fields' })
  @ApiQuery({ name: 'agentId', required: false, type: String, description: 'Filter by agent UUID' })
  @ApiResponse({ status: 200, description: 'Paginated list of memory records' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  list(
    @CurrentUser('organizationId') organizationId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ) {
    return this.memoryService.list(organizationId, query);
  }

  @Post()
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE, UserRole.DEVELOPER)
  @ApiOperation({
    summary: 'Record an agent decision in memory',
    description:
      'Stores a new memory record capturing an agent decision, its reasoning, and outcome. ' +
      'Memory records are immutable once created.',
  })
  @ApiBody({ type: CreateMemoryDto })
  @ApiResponse({ status: 201, description: 'Memory record created successfully' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  create(
    @CurrentUser('organizationId') organizationId: string,
    @Body(new ZodValidationPipe(createMemorySchema)) body: CreateMemoryInput,
  ) {
    return this.memoryService.create(organizationId, body);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a memory record',
    description: 'Returns full details of a single memory record by ID.',
  })
  @ApiParam({ name: 'id', description: 'Memory record UUID', example: '018f0a1b-...' })
  @ApiResponse({ status: 200, description: 'Memory record details' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Memory record not found' })
  findOne(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.memoryService.getOrThrow(organizationId, id);
  }
}
