import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
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
import { TransactionService } from './transaction.service';
import {
  createTransactionSchema,
  CreateTransactionInput,
  CreateTransactionDto,
  simulateTransactionSchema,
  SimulateTransactionInput,
} from './transaction.dto';
import { SpendingLimitGuard, RequireSpendingLimitCheck } from './guards/spending-limit.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuditAction } from '../../common/decorators/audit-action.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { UseWalletLock } from '../../common/locks/wallet-lock.decorator';
import { UseTransactionLock } from '../../common/locks/transaction-lock.decorator';
import { AgentThrottlerGuard } from '../../common/guards/agent-throttler.guard';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { PaginationQuery, paginationQuerySchema } from '../../common/helpers/pagination';
import { ApiEnvelope } from '../../common/decorators/api-envelope.decorator';
import {
  SlidingWindowThrottlerGuard,
  SlidingWindowLimit,
} from '../../common/guards/sliding-window-throttler.guard';

@ApiTags('transactions')
@ApiBearerAuth('access-token')
@UseGuards(AgentThrottlerGuard)
@Controller('transactions')
export class TransactionController {
  constructor(private readonly transactionService: TransactionService) {}

  @Get()
  @ApiOperation({
    summary: 'List transactions',
    description:
      'Returns a paginated list of transactions for the current organization. Supports filtering by status, agent, wallet, and date range.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 20)' })
  @ApiQuery({ name: 'status', required: false, enum: ['DRAFT', 'PENDING', 'APPROVED', 'COMPLETED', 'FAILED', 'CANCELLED'], description: 'Filter by transaction status' })
  @ApiQuery({ name: 'agentId', required: false, type: String, description: 'Filter by agent UUID' })
  @ApiQuery({ name: 'walletId', required: false, type: String, description: 'Filter by wallet UUID' })
  @ApiEnvelope(CreateTransactionDto as never, { isArray: true })
  @ApiResponse({ status: 200, description: 'Paginated list of transactions' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  list(
    @CurrentUser('organizationId') organizationId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ) {
    return this.transactionService.list(organizationId, query);
  }

  @Post()
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE, UserRole.DEVELOPER)
  @UseGuards(SlidingWindowThrottlerGuard, SpendingLimitGuard)
  @SlidingWindowLimit(30, 60)
  @RequireSpendingLimitCheck()
  @UseWalletLock()
  @UseTransactionLock({ attempts: 3, retryDelayMs: 50 })
  @AuditAction('TRANSFER_FUNDS')
  @ApiOperation({
    summary: 'Create a transaction (runs the full governance pipeline)',
    description:
      'Evaluates policies, scores risk and checks budgets. Auto-executes when permitted, ' +
      'otherwise creates an approval proposal and returns requiresApproval=true. ' +
      'Agent transactions are additionally evaluated against daily/weekly/monthly spending ' +
      'limit policies before reaching the service layer.',
  })
  @ApiBody({ type: CreateTransactionDto })
  @ApiEnvelope(CreateTransactionDto as never)
  @ApiResponse({ status: 201, description: 'Transaction created (may require approval)' })
  @ApiResponse({ status: 400, description: 'Validation error or policy violation' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 409, description: 'Insufficient budget or risk threshold exceeded' })
  @ApiResponse({
    status: 422,
    description: 'Transaction blocked by spending limit policy (POLICY_VIOLATION)',
  })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createTransactionSchema)) body: CreateTransactionInput,
  ) {
    const actorId = user.isApiKey ? user.createdById ?? user.id : user.id;
    return this.transactionService.create(user.organizationId, actorId, body);
  }

  @Post('simulate')
  @UseGuards(SlidingWindowThrottlerGuard)
  @SlidingWindowLimit(60, 60)
  @ApiOperation({
    summary: 'Dry-run the governance pipeline without moving funds',
    description:
      'Simulates policy evaluation, risk scoring, and budget checks for a hypothetical transaction. ' +
      'Returns the results without creating any records or moving funds.',
  })
  @ApiBody({ type: CreateTransactionDto })
  @ApiResponse({ status: 200, description: 'Simulation results with policy/risk/budget outcomes' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  simulate(
    @CurrentUser('organizationId') organizationId: string,
    @Body(new ZodValidationPipe(simulateTransactionSchema)) body: SimulateTransactionInput,
  ) {
    return this.transactionService.simulate(organizationId, body);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a transaction',
    description: 'Returns full details of a single transaction by ID.',
  })
  @ApiParam({ name: 'id', description: 'Transaction UUID', example: '018f0a1b-...' })
  @ApiEnvelope(CreateTransactionDto as never)
  @ApiResponse({ status: 200, description: 'Transaction details' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Transaction not found' })
  findOne(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.transactionService.getOrThrow(organizationId, id);
  }

  @Post(':id/cancel')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE)
  @AuditAction('TRANSFER_CANCELLED')
  @ApiOperation({
    summary: 'Cancel a draft or pending transaction',
    description:
      'Cancels a transaction that is in DRAFT or PENDING status. ' +
      'Completed or already cancelled transactions cannot be cancelled.',
  })
  @ApiParam({ name: 'id', description: 'Transaction UUID', example: '018f0a1b-...' })
  @ApiResponse({ status: 200, description: 'Transaction cancelled successfully' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Transaction not found' })
  @ApiResponse({ status: 409, description: 'Transaction cannot be cancelled (wrong status)' })
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.transactionService.cancel(user.organizationId, user.id, id);
  }
}
