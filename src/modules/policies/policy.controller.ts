import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
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
import { PolicyService } from './policy.service';
import {
  createPolicySchema,
  CreatePolicyInput,
  CreatePolicyDto,
  simulatePolicySchema,
  SimulatePolicyInput,
  SimulatePolicyDto,
  updatePolicySchema,
  UpdatePolicyInput,
} from './policy.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuditAction } from '../../common/decorators/audit-action.decorator';
import { AuditLog } from '../../common/decorators/audit-log.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import {
  PaginationQuery,
  paginationQuerySchema,
} from '../../common/helpers/pagination';
import { ApiEnvelope } from '../../common/decorators/api-envelope.decorator';

@ApiTags('policies')
@ApiBearerAuth('access-token')
@Controller('policies')
export class PolicyController {
  constructor(private readonly policyService: PolicyService) {}

  @Get()
  @ApiOperation({
    summary: 'List policies',
    description:
      'Returns a paginated list of policies for the current organization. ' +
      'Supports filtering by type, status, and agent.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 20)' })
  @ApiQuery({ name: 'type', required: false, enum: ['SPENDING_LIMIT', 'APPROVAL_REQUIRED', 'ALLOWLIST', 'TIME_WINDOW'], description: 'Filter by policy type' })
  @ApiQuery({ name: 'enabled', required: false, type: Boolean, description: 'Filter by enabled status' })
  @ApiEnvelope(CreatePolicyDto as never, { isArray: true })
  @ApiResponse({ status: 200, description: 'Paginated list of policies' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  list(
    @CurrentUser('organizationId') organizationId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ) {
    return this.policyService.list(organizationId, query);
  }

  @Post()
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE)
  @AuditAction('POLICY_CREATED')
  @AuditLog({ action: 'POLICY_CREATED', entity: 'Policy' })
  @ApiOperation({
    summary: 'Create a policy',
    description:
      'Creates a new governance policy. Policies evaluate transaction intents and enforce spending rules.',
  })
  @ApiBody({ type: CreatePolicyDto })
  @ApiEnvelope(CreatePolicyDto as never)
  @ApiResponse({ status: 201, description: 'Policy created successfully' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions (requires OWNER, ADMIN, or FINANCE)' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createPolicySchema)) body: CreatePolicyInput,
  ) {
    return this.policyService.create(user.organizationId, user.id, body);
  }

  @Post('simulate')
  @ApiOperation({
    summary: 'Simulate a transaction intent against active policies',
    description:
      'Dry-runs a hypothetical transaction through the policy engine without creating any records. ' +
      'Returns which policies would match and their enforcement actions.',
  })
  @ApiBody({ type: SimulatePolicyDto })
  @ApiResponse({ status: 200, description: 'Simulation results with matching policies' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  simulate(
    @CurrentUser('organizationId') organizationId: string,
    @Body(new ZodValidationPipe(simulatePolicySchema)) body: SimulatePolicyInput,
  ) {
    return this.policyService.simulate(organizationId, body);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a policy',
    description: 'Returns full details of a single policy by ID.',
  })
  @ApiParam({ name: 'id', description: 'Policy UUID', example: '018f0a1b-...' })
  @ApiEnvelope(CreatePolicyDto as never)
  @ApiResponse({ status: 200, description: 'Policy details' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Policy not found' })
  findOne(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.policyService.getOrThrow(organizationId, id);
  }

  @Patch(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE)
  @AuditAction('POLICY_UPDATED')
  @AuditLog({ action: 'POLICY_UPDATED', entity: 'Policy' })
  @ApiOperation({
    summary: 'Update a policy',
    description:
      'Partial update of policy fields (name, type, configuration, priority, enabled).',
  })
  @ApiParam({ name: 'id', description: 'Policy UUID', example: '018f0a1b-...' })
  @ApiBody({ type: CreatePolicyDto })
  @ApiResponse({ status: 200, description: 'Policy updated successfully' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Policy not found' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updatePolicySchema)) body: UpdatePolicyInput,
  ) {
    return this.policyService.update(user.organizationId, user.id, id, body);
  }

  @Delete(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @AuditAction('POLICY_DELETED')
  @AuditLog({ action: 'POLICY_DELETED', entity: 'Policy' })
  @ApiOperation({
    summary: 'Delete (soft) a policy',
    description:
      'Soft-deletes the policy. The policy record is retained for audit purposes but is excluded from active queries.',
  })
  @ApiParam({ name: 'id', description: 'Policy UUID', example: '018f0a1b-...' })
  @ApiResponse({ status: 200, description: 'Policy deleted successfully' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions (requires OWNER or ADMIN)' })
  @ApiResponse({ status: 404, description: 'Policy not found' })
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.policyService.remove(user.organizationId, user.id, id);
  }
}
