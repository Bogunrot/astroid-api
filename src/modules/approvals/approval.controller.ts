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
import { ApprovalDecision, UserRole } from '@prisma/client';
import { ApprovalService } from './approval.service';
import {
  decideProposalSchema,
  DecideProposalInput,
  DecideProposalDto,
  decisionCommentSchema,
  DecisionCommentInput,
  DecisionCommentDto,
} from './approval.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuditAction } from '../../common/decorators/audit-action.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { PaginationQuery, paginationQuerySchema } from '../../common/helpers/pagination';
import { ApiPaginationQuery } from '../../common/decorators/api-pagination-query.decorator';

@ApiTags('approvals')
@ApiBearerAuth('access-token')
@Controller('proposals')
export class ApprovalController {
  constructor(private readonly approvalService: ApprovalService) {}

  @Get()
  @ApiOperation({
    summary: 'List approval proposals',
    description:
      'Returns a paginated list of approval proposals for the current organization. ' +
      'Supports filtering by status.',
  })
  @ApiPaginationQuery()
  @ApiQuery({ name: 'status', required: false, enum: ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'], description: 'Filter by proposal status' })
  @ApiResponse({ status: 200, description: 'Paginated list of proposals' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  list(
    @CurrentUser('organizationId') organizationId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ) {
    return this.approvalService.list(organizationId, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a proposal with its approvals',
    description:
      'Returns full details of a proposal including all approval/rejection decisions.',
  })
  @ApiParam({ name: 'id', description: 'Proposal UUID', example: '018f0a1b-...' })
  @ApiResponse({ status: 200, description: 'Proposal details with approvals' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Proposal not found' })
  findOne(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.approvalService.getOrThrow(organizationId, id);
  }

  @Post(':id/decision')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE)
  @AuditAction('PROPOSAL_DECIDED')
  @ApiOperation({
    summary: 'Approve or reject a proposal',
    description:
      'When the approval threshold is met the underlying transaction is executed automatically. ' +
      'A single rejection from an authorized reviewer rejects the whole proposal.',
  })
  @ApiParam({ name: 'id', description: 'Proposal UUID', example: '018f0a1b-...' })
  @ApiBody({ type: DecideProposalDto })
  @ApiResponse({ status: 200, description: 'Decision recorded (transaction may execute automatically)' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Proposal not found' })
  @ApiResponse({ status: 409, description: 'Proposal already decided or expired' })
  decide(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(decideProposalSchema)) body: DecideProposalInput,
  ) {
    return this.approvalService.decide(user.organizationId, user.id, id, body);
  }

  @Post(':id/approve')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE)
  @AuditAction('PROPOSAL_APPROVED')
  @ApiOperation({
    summary: 'Approve a proposal (PRD alias of POST /:id/decision)',
    description:
      'Records an APPROVED vote. When the approval threshold is met the ' +
      'underlying transaction is executed automatically.',
  })
  @ApiParam({ name: 'id', description: 'Proposal UUID', example: '018f0a1b-...' })
  @ApiBody({ type: DecisionCommentDto })
  @ApiResponse({ status: 200, description: 'Approval recorded (transaction may execute automatically)' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Proposal not found' })
  @ApiResponse({ status: 409, description: 'Proposal already decided or expired' })
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(decisionCommentSchema)) body: DecisionCommentInput,
  ) {
    return this.approvalService.decide(user.organizationId, user.id, id, {
      decision: ApprovalDecision.APPROVED,
      comment: body.comment,
    });
  }

  @Post(':id/reject')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE)
  @AuditAction('PROPOSAL_REJECTED')
  @ApiOperation({
    summary: 'Reject a proposal (PRD alias of POST /:id/decision)',
    description:
      'A single rejection rejects the whole proposal and cancels the transaction.',
  })
  @ApiParam({ name: 'id', description: 'Proposal UUID', example: '018f0a1b-...' })
  @ApiBody({ type: DecisionCommentDto })
  @ApiResponse({ status: 200, description: 'Rejection recorded (transaction cancelled)' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Proposal not found' })
  @ApiResponse({ status: 409, description: 'Proposal already decided or expired' })
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(decisionCommentSchema)) body: DecisionCommentInput,
  ) {
    return this.approvalService.decide(user.organizationId, user.id, id, {
      decision: ApprovalDecision.REJECTED,
      comment: body.comment,
    });
  }
}
