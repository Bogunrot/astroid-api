import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
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
import { UserRole } from '@prisma/client';
import { BudgetService } from './budget.service';
import { UseBudgetLock } from '../../common/locks/budget-lock.decorator';
import {
  allocateBudgetSchema,
  AllocateBudgetInput,
  AllocateBudgetDto,
  createBudgetSchema,
  CreateBudgetInput,
  CreateBudgetDto,
  updateBudgetSchema,
  UpdateBudgetInput,
} from './budget.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuditAction } from '../../common/decorators/audit-action.decorator';
import { AuditLog } from '../../common/decorators/audit-log.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { PaginationQuery, paginationQuerySchema } from '../../common/helpers/pagination';
import { ApiEnvelope } from '../../common/decorators/api-envelope.decorator';

@ApiTags('budgets')
@ApiBearerAuth('access-token')
@Controller('budgets')
export class BudgetController {
  constructor(private readonly budgetService: BudgetService) {}

  @Get()
  @ApiOperation({
    summary: 'List budgets',
    description:
      'Returns a paginated list of budgets for the current organization. ' +
      'Supports filtering by period and status.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 20)' })
  @ApiQuery({ name: 'period', required: false, enum: ['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'], description: 'Filter by budget period' })
  @ApiQuery({ name: 'enabled', required: false, type: Boolean, description: 'Filter by enabled status' })
  @ApiEnvelope(CreateBudgetDto as never, { isArray: true })
  @ApiResponse({ status: 200, description: 'Paginated list of budgets' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  list(
    @CurrentUser('organizationId') organizationId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ) {
    return this.budgetService.list(organizationId, query);
  }

  @Post()
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE)
  @AuditAction('BUDGET_CREATED')
  @AuditLog({ action: 'BUDGET_CREATED', entity: 'Budget' })
  @ApiOperation({
    summary: 'Create a budget',
    description:
      'Creates a new budget with spending limits. Budgets can be hierarchical with parent-child relationships.',
  })
  @ApiBody({ type: CreateBudgetDto })
  @ApiEnvelope(CreateBudgetDto as never)
  @ApiResponse({ status: 201, description: 'Budget created successfully' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions (requires OWNER, ADMIN, or FINANCE)' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createBudgetSchema)) body: CreateBudgetInput,
  ) {
    return this.budgetService.create(user.organizationId, user.id, body);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a budget with remaining balance and children',
    description:
      'Returns full details of a budget including its remaining balance, spending history, and child budgets.',
  })
  @ApiParam({ name: 'id', description: 'Budget UUID', example: '018f0a1b-...' })
  @ApiEnvelope(CreateBudgetDto as never)
  @ApiResponse({ status: 200, description: 'Budget details with balance and children' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Budget not found' })
  findOne(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.budgetService.getDetail(organizationId, id);
  }

  @Patch(':id')
  @UseBudgetLock()
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE)
  @AuditAction('BUDGET_UPDATED')
  @AuditLog({ action: 'BUDGET_UPDATED', entity: 'Budget' })
  @ApiOperation({
    summary: 'Update a budget',
    description: 'Partial update of budget fields (name, limit, period, rollover, enabled).',
  })
  @ApiParam({ name: 'id', description: 'Budget UUID', example: '018f0a1b-...' })
  @ApiBody({ type: CreateBudgetDto })
  @ApiResponse({ status: 200, description: 'Budget updated successfully' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Budget not found' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateBudgetSchema)) body: UpdateBudgetInput,
  ) {
    return this.budgetService.update(user.organizationId, user.id, id, body);
  }

  @Post(':id/allocate')
  @UseBudgetLock()
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE)
  @AuditAction('BUDGET_ALLOCATED')
  @AuditLog({ action: 'BUDGET_ADJUSTED', entity: 'Budget' })
  @ApiOperation({
    summary: 'Allocate funds from the parent budget to this child',
    description:
      'Transfers funds from a parent budget to a child budget. The parent must have sufficient remaining balance.',
  })
  @ApiParam({ name: 'id', description: 'Child budget UUID', example: '018f0a1b-...' })
  @ApiBody({ type: AllocateBudgetDto })
  @ApiResponse({ status: 200, description: 'Funds allocated successfully' })
  @ApiResponse({ status: 400, description: 'Validation error or insufficient parent balance' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Budget not found' })
  @ApiResponse({ status: 409, description: 'Parent budget has insufficient balance' })
  allocate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(allocateBudgetSchema)) body: AllocateBudgetInput,
  ) {
    return this.budgetService.allocate(user.organizationId, user.id, id, body);
  }

  @Delete(':id')
  @UseBudgetLock()
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE)
  @AuditAction('BUDGET_DELETED')
  @AuditLog({ action: 'BUDGET_DELETED', entity: 'Budget' })
  @ApiOperation({
    summary: 'Delete (soft) a budget',
    description:
      'Soft-deletes the budget. The budget record is retained for audit purposes but is excluded from active queries. ' +
      'Child budgets are also soft-deleted.',
  })
  @ApiParam({ name: 'id', description: 'Budget UUID', example: '018f0a1b-...' })
  @ApiResponse({ status: 200, description: 'Budget deleted successfully' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Budget not found' })
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.budgetService.remove(user.organizationId, user.id, id);
  }
}
