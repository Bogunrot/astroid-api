import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiBearerAuth,
  ApiResponse,
  ApiParam,
  ApiBody,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { OrganizationService } from './organization.service';
import {
  inviteMemberSchema,
  InviteMemberInput,
  InviteMemberDto,
  updateMemberSchema,
  UpdateMemberInput,
  UpdateMemberDto,
  updateOrganizationSchema,
  UpdateOrganizationInput,
  UpdateOrganizationDto,
} from './organization.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuditAction } from '../../common/decorators/audit-action.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { PaginationQuery, paginationQuerySchema } from '../../common/helpers/pagination';
import { ApiPaginationQuery } from '../../common/decorators/api-pagination-query.decorator';

@ApiTags('organizations')
@ApiBearerAuth('access-token')
@Controller('organizations')
export class OrganizationController {
  constructor(private readonly organizationService: OrganizationService) {}

  @Get('current')
  @ApiOperation({
    summary: 'Get the current organization',
    description: 'Returns the organization details for the authenticated user.',
  })
  @ApiResponse({ status: 200, description: 'Organization details' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Organization not found' })
  getCurrent(@CurrentUser('organizationId') organizationId: string) {
    return this.organizationService.getCurrent(organizationId);
  }

  @Patch('current')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @AuditAction('ORGANIZATION_UPDATED')
  @ApiOperation({
    summary: 'Update the current organization',
    description: 'Partial update of organization fields (name, settings, etc.).',
  })
  @ApiBody({ type: UpdateOrganizationDto })
  @ApiResponse({ status: 200, description: 'Organization updated successfully' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions (requires OWNER or ADMIN)' })
  updateCurrent(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(updateOrganizationSchema)) body: UpdateOrganizationInput,
  ) {
    return this.organizationService.updateCurrent(user.organizationId, user.id, body);
  }

  @Get('members')
  @ApiOperation({
    summary: 'List organization members',
    description: 'Returns a paginated list of members in the current organization.',
  })
  @ApiPaginationQuery()
  @ApiResponse({ status: 200, description: 'Paginated list of members' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  listMembers(
    @CurrentUser('organizationId') organizationId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ) {
    return this.organizationService.listMembers(organizationId, query);
  }

  @Post('members')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @AuditAction('MEMBER_INVITED')
  @ApiOperation({
    summary: 'Invite a new member',
    description:
      'Sends an invitation to join the organization. The invited user will receive an email with an activation link.',
  })
  @ApiBody({ type: InviteMemberDto })
  @ApiResponse({ status: 201, description: 'Invitation sent successfully' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions (requires OWNER or ADMIN)' })
  @ApiResponse({ status: 409, description: 'User already a member of this organization' })
  inviteMember(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(inviteMemberSchema)) body: InviteMemberInput,
  ) {
    return this.organizationService.inviteMember(user.organizationId, user.id, body);
  }

  @Patch('members/:id')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @AuditAction('MEMBER_UPDATED')
  @ApiOperation({
    summary: 'Update a member role or status',
    description:
      'Changes the role or status of an existing member. Only owners and admins can modify member roles.',
  })
  @ApiParam({ name: 'id', description: 'Member UUID', example: '018f0a1b-...' })
  @ApiBody({ type: UpdateMemberDto })
  @ApiResponse({ status: 200, description: 'Member updated successfully' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Member not found' })
  updateMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateMemberSchema)) body: UpdateMemberInput,
  ) {
    return this.organizationService.updateMember(user.organizationId, user.id, id, body);
  }

  @Delete('members/:id')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @AuditAction('MEMBER_REMOVED')
  @ApiOperation({
    summary: 'Remove (soft) a member',
    description:
      'Soft-deletes a member from the organization. The member record is retained for audit purposes.',
  })
  @ApiParam({ name: 'id', description: 'Member UUID', example: '018f0a1b-...' })
  @ApiResponse({ status: 200, description: 'Member removed successfully' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Member not found' })
  removeMember(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.organizationService.removeMember(user.organizationId, user.id, id);
  }
}
