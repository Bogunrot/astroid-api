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
import { UserRole, WalletStatus } from '@prisma/client';
import { WalletService } from './wallet.service';
import {
  createWalletSchema,
  CreateWalletInput,
  CreateWalletDto,
  updateWalletSchema,
  UpdateWalletInput,
  UpdateWalletDto,
  WalletResponseDto,
  WalletBalanceDto,
} from './wallet.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuditAction } from '../../common/decorators/audit-action.decorator';
import { AuditLog } from '../../common/decorators/audit-log.decorator';
import { AgentThrottlerGuard } from '../../common/guards/agent-throttler.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { PaginationQuery, paginationQuerySchema } from '../../common/helpers/pagination';
import { ApiPaginationQuery } from '../../common/decorators/api-pagination-query.decorator';
import { ApiEnvelope } from '../../common/decorators/api-envelope.decorator';
import { AstroidThrottlerGuard } from '../../common/guards/throttler.guard';

@ApiTags('wallets')
@ApiBearerAuth('access-token')
@UseGuards(AgentThrottlerGuard)
@Controller('wallets')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get()
  @ApiOperation({
    summary: 'List wallets',
    description:
      'Returns a paginated list of wallets for the current organization. ' +
      'Supports filtering by status and network.',
  })
  @ApiPaginationQuery()
  @ApiQuery({ name: 'status', required: false, enum: ['ACTIVE', 'FROZEN', 'ARCHIVED'], description: 'Filter by wallet status' })
  @ApiQuery({ name: 'network', required: false, enum: ['TESTNET', 'PUBLIC'], description: 'Filter by Stellar network' })
  @ApiEnvelope(WalletResponseDto as never, { isArray: true })
  @ApiResponse({ status: 200, description: 'Paginated list of wallets' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  list(
    @CurrentUser('organizationId') organizationId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ) {
    return this.walletService.list(organizationId, query);
  }

  @Post()
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE, UserRole.DEVELOPER)
  @UseGuards(AstroidThrottlerGuard)
  @AuditAction('WALLET_CREATED')
  @ApiOperation({
    summary: 'Create a wallet (generate a keypair or import an address)',
    description:
      'When generating, the secret key is returned exactly once and never stored server-side. ' +
      'When importing, only the public address is recorded for balance tracking.',
  })
  @ApiBody({ type: CreateWalletDto })
  @ApiResponse({ status: 201, description: 'Wallet created successfully (secret key included on generation)', type: WalletResponseDto })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createWalletSchema)) body: CreateWalletInput,
  ) {
    return this.walletService.create(user.organizationId, user.id, body);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a wallet',
    description: 'Returns full details of a single wallet by ID.',
  })
  @ApiParam({ name: 'id', description: 'Wallet UUID', example: '018f0a1b-...' })
  @ApiResponse({ status: 200, description: 'Wallet details', type: WalletResponseDto })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Wallet not found' })
  findOne(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.walletService.getOrThrow(organizationId, id);
  }

  @Get(':id/balances')
  @ApiOperation({
    summary: 'Fetch live on-chain balances for a wallet',
    description:
      'Queries the Stellar network for the current balances of the wallet. ' +
      'For generated wallets, this includes XLM and all trustline assets.',
  })
  @ApiParam({ name: 'id', description: 'Wallet UUID', example: '018f0a1b-...' })
  @ApiResponse({ status: 200, description: 'Current on-chain balances', type: [WalletBalanceDto] })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Wallet not found' })
  @ApiResponse({ status: 502, description: 'Stellar network error' })
  balances(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.walletService.getBalances(organizationId, id);
  }

  @Patch(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE, UserRole.DEVELOPER)
  @AuditAction('WALLET_UPDATED')
  @AuditLog({ action: 'WALLET_UPDATED', entity: 'Wallet' })
  @ApiOperation({
    summary: 'Update a wallet label or owning agent',
    description: 'Partial update of wallet metadata. Does not affect the Stellar keypair.',
  })
  @ApiParam({ name: 'id', description: 'Wallet UUID', example: '018f0a1b-...' })
  @ApiBody({ type: UpdateWalletDto })
  @ApiResponse({ status: 200, description: 'Wallet updated successfully', type: WalletResponseDto })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Wallet not found' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateWalletSchema)) body: UpdateWalletInput,
  ) {
    return this.walletService.update(user.organizationId, user.id, id, body);
  }

  @Post(':id/freeze')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE)
  @AuditAction('WALLET_FROZEN')
  @AuditLog({ action: 'WALLET_FROZEN', entity: 'Wallet' })
  @ApiOperation({
    summary: 'Freeze a wallet (block outgoing transactions)',
    description:
      'Places the wallet in FROZEN status. All outgoing transactions will be blocked until the wallet is unfrozen.',
  })
  @ApiParam({ name: 'id', description: 'Wallet UUID', example: '018f0a1b-...' })
  @ApiResponse({ status: 200, description: 'Wallet frozen successfully', type: WalletResponseDto })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Wallet not found' })
  @ApiResponse({ status: 409, description: 'Wallet is already frozen' })
  freeze(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.walletService.setStatus(user.organizationId, user.id, id, WalletStatus.FROZEN);
  }

  @Post(':id/unfreeze')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE)
  @AuditAction('WALLET_UNFROZEN')
  @AuditLog({ action: 'WALLET_UNFROZEN', entity: 'Wallet' })
  @ApiOperation({
    summary: 'Unfreeze a wallet',
    description: 'Restores a frozen wallet to ACTIVE status, allowing outgoing transactions again.',
  })
  @ApiParam({ name: 'id', description: 'Wallet UUID', example: '018f0a1b-...' })
  @ApiResponse({ status: 200, description: 'Wallet unfrozen successfully', type: WalletResponseDto })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Wallet not found' })
  @ApiResponse({ status: 409, description: 'Wallet is not frozen' })
  unfreeze(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.walletService.setStatus(user.organizationId, user.id, id, WalletStatus.ACTIVE);
  }

  @Delete(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @AuditAction('WALLET_ARCHIVED')
  @AuditLog({ action: 'WALLET_ARCHIVED', entity: 'Wallet' })
  @ApiOperation({
    summary: 'Archive (soft-delete) a wallet',
    description:
      'Soft-deletes the wallet. The wallet record is retained for audit purposes but is excluded from active queries. ' +
      'Associated Stellar keys are securely wiped.',
  })
  @ApiParam({ name: 'id', description: 'Wallet UUID', example: '018f0a1b-...' })
  @ApiResponse({ status: 200, description: 'Wallet archived successfully' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions (requires OWNER or ADMIN)' })
  @ApiResponse({ status: 404, description: 'Wallet not found' })
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.walletService.remove(user.organizationId, user.id, id);
  }
}
