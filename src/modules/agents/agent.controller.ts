import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiBearerAuth,
  ApiResponse,
  ApiParam,
  ApiBody,
  ApiQuery,
} from '@nestjs/swagger';
import { AgentStatus, UserRole } from '@prisma/client';
import { AgentService } from './agent.service';
import {
  assignWalletSchema,
  AssignWalletInput,
  AssignWalletDto,
  createAgentSchema,
  CreateAgentInput,
  CreateAgentDto,
  updateAgentSchema,
  UpdateAgentInput,
  AgentResponseDto,
} from './agent.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuditAction } from '../../common/decorators/audit-action.decorator';
import { UseAgentLock } from '../../common/locks/agent-lock.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { PaginationQuery, paginationQuerySchema } from '../../common/helpers/pagination';
import { ApiEnvelope } from '../../common/decorators/api-envelope.decorator';
import { AgentRateLimiterGuard } from './guards/agent-rate-limiter.guard';
import { AgentThrottlerGuard } from '../../common/guards/agent-throttler.guard';

@ApiTags('agents')
@ApiBearerAuth('access-token')
@UseGuards(AgentThrottlerGuard)
@Controller('agents')
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

  @Get()
  @ApiOperation({
    summary: 'List agents',
    description: 'Returns a paginated list of agents for the current organization.',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (default: 1)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Items per page (default: 20)',
  })
  @ApiEnvelope(AgentResponseDto as never, { isArray: true })
  @ApiResponse({ status: 200, description: 'Paginated list of agents' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  list(
    @CurrentUser('organizationId') organizationId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ) {
    return this.agentService.list(organizationId, query);
  }

  @Post()
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @AuditAction('AGENT_CREATED')
  @ApiOperation({
    summary: 'Register a new agent',
    description:
      'Creates a new agent under the current organization. The agent starts in ACTIVE status.',
  })
  @ApiBody({ type: CreateAgentDto })
  @ApiResponse({ status: 201, description: 'Agent created successfully', type: AgentResponseDto })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Insufficient permissions (requires OWNER, ADMIN, or DEVELOPER)',
  })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createAgentSchema)) body: CreateAgentInput,
  ) {
    return this.agentService.create(user.organizationId, user.id, body);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get an agent',
    description: 'Returns full details of a single agent by ID.',
  })
  @ApiParam({ name: 'id', description: 'Agent UUID', example: '018f0a1b-...' })
  @ApiResponse({ status: 200, description: 'Agent details', type: AgentResponseDto })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  findOne(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.agentService.getOrThrow(organizationId, id);
  }

  @Patch(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @AuditAction('AGENT_UPDATED')
  @UseAgentLock()
  @ApiOperation({
    summary: 'Update an agent',
    description: 'Partial update of agent fields (name, description, model, capabilities, etc.).',
  })
  @ApiParam({ name: 'id', description: 'Agent UUID', example: '018f0a1b-...' })
  @ApiBody({ type: CreateAgentDto })
  @ApiResponse({ status: 200, description: 'Agent updated successfully', type: AgentResponseDto })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateAgentSchema)) body: UpdateAgentInput,
  ) {
    return this.agentService.update(user.organizationId, user.id, id, body);
  }

  @Post(':id/pause')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @AuditAction('AGENT_PAUSED')
  @UseAgentLock()
  @ApiOperation({
    summary: 'Pause an agent',
    description: 'Temporarily pauses the agent. Paused agents cannot initiate transactions.',
  })
  @ApiParam({ name: 'id', description: 'Agent UUID', example: '018f0a1b-...' })
  @ApiResponse({ status: 200, description: 'Agent paused successfully', type: AgentResponseDto })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  pause(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.agentService.setStatus(user.organizationId, user.id, id, AgentStatus.PAUSED);
  }

  @Post(':id/resume')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @AuditAction('AGENT_RESUMED')
  @UseAgentLock()
  @ApiOperation({
    summary: 'Reactivate an agent',
    description: 'Resumes a paused agent back to ACTIVE status.',
  })
  @ApiParam({ name: 'id', description: 'Agent UUID', example: '018f0a1b-...' })
  @ApiResponse({ status: 200, description: 'Agent resumed successfully', type: AgentResponseDto })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  resume(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.agentService.setStatus(user.organizationId, user.id, id, AgentStatus.ACTIVE);
  }

  @Post(':id/suspend')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @AuditAction('AGENT_SUSPENDED')
  @UseAgentLock()
  @ApiOperation({
    summary: 'Suspend an agent',
    description:
      'Permanently suspends the agent. Suspended agents cannot be reactivated without admin intervention.',
  })
  @ApiParam({ name: 'id', description: 'Agent UUID', example: '018f0a1b-...' })
  @ApiResponse({ status: 200, description: 'Agent suspended successfully', type: AgentResponseDto })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions (requires OWNER or ADMIN)' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  suspend(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.agentService.setStatus(user.organizationId, user.id, id, AgentStatus.SUSPENDED);
  }

  @Post(':id/wallet')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @AuditAction('AGENT_WALLET_ASSIGNED')
  @UseAgentLock()
  @ApiOperation({
    summary: 'Assign a primary wallet to an agent',
    description:
      'Links a wallet to the agent as its primary wallet. The wallet must belong to the same organization.',
  })
  @ApiParam({ name: 'id', description: 'Agent UUID', example: '018f0a1b-...' })
  @ApiBody({ type: AssignWalletDto })
  @ApiResponse({ status: 200, description: 'Wallet assigned successfully', type: AgentResponseDto })
  @ApiResponse({ status: 400, description: 'Validation error (invalid wallet UUID)' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Agent or wallet not found' })
  assignWallet(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(assignWalletSchema)) body: AssignWalletInput,
  ) {
    return this.agentService.assignWallet(user.organizationId, user.id, id, body);
  }

  @Delete(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @AuditAction('AGENT_ARCHIVED')
  @UseAgentLock()
  @ApiOperation({
    summary: 'Archive (soft delete) an agent',
    description:
      'Soft-deletes the agent. The agent record is retained for audit purposes but is excluded from active queries.',
  })
  @ApiParam({ name: 'id', description: 'Agent UUID', example: '018f0a1b-...' })
  @ApiResponse({ status: 200, description: 'Agent archived successfully' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions (requires OWNER or ADMIN)' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.agentService.remove(user.organizationId, user.id, id);
  }

  @Post(':id/execute')
  @UseGuards(AgentRateLimiterGuard)
  @ApiOperation({ summary: 'Trigger an execution for the agent' })
  @ApiResponse({ status: 200, description: 'Execution triggered' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async execute(@CurrentUser('organizationId') _organizationId: string, @Param('id') _id: string) {
    return { success: true, message: 'Execution triggered' };
  }
}
