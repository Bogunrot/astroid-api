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
import { WebhookService } from './webhook.service';
import {
  createWebhookSchema,
  CreateWebhookInput,
  CreateWebhookDto,
  updateWebhookSchema,
  UpdateWebhookInput,
  WebhookSecretDto,
} from './webhook.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuditAction } from '../../common/decorators/audit-action.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PaginationQuery, paginationQuerySchema } from '../../common/helpers/pagination';
import { ThrottleTierDecorator } from '../../common/decorators/throttle-tier.decorator';

@ApiTags('webhooks')
@ApiBearerAuth('access-token')
@Controller('webhooks')
@ThrottleTierDecorator('webhook')
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  @Get()
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @ApiOperation({
    summary: 'List webhooks (signing secrets are never returned)',
    description:
      'Returns a paginated list of webhooks for the current organization. ' +
      'HMAC signing secrets are never included in the response.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 20)' })
  @ApiQuery({ name: 'events', required: false, type: String, description: 'Filter by event type' })
  @ApiResponse({ status: 200, description: 'Paginated list of webhooks' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  list(
    @CurrentUser('organizationId') organizationId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ) {
    return this.webhookService.list(organizationId, query);
  }

  @Post()
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @AuditAction('WEBHOOK_CREATED')
  @ApiOperation({
    summary: 'Create a webhook',
    description:
      'The HMAC signing secret is returned exactly once in this response. ' +
      'Store it securely — it cannot be retrieved later.',
  })
  @ApiBody({ type: CreateWebhookDto })
  @ApiResponse({
    status: 201,
    description: 'Webhook created successfully (includes signing secret)',
    type: WebhookSecretDto,
  })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid URL or event types' })
  create(
    @CurrentUser('organizationId') organizationId: string,
    @Body(new ZodValidationPipe(createWebhookSchema)) body: CreateWebhookInput,
  ) {
    return this.webhookService.create(organizationId, body);
  }

  @Get(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @ApiOperation({
    summary: 'Get a webhook',
    description: 'Returns full details of a single webhook by ID.',
  })
  @ApiParam({ name: 'id', description: 'Webhook UUID', example: '018f0a1b-...' })
  @ApiResponse({ status: 200, description: 'Webhook details' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  findOne(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.webhookService.get(organizationId, id);
  }

  @Patch(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @AuditAction('WEBHOOK_UPDATED')
  @ApiOperation({
    summary: 'Update a webhook',
    description: 'Partial update of webhook configuration (URL, events, enabled status).',
  })
  @ApiParam({ name: 'id', description: 'Webhook UUID', example: '018f0a1b-...' })
  @ApiBody({ type: CreateWebhookDto })
  @ApiResponse({ status: 200, description: 'Webhook updated successfully' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  update(
    @CurrentUser('organizationId') organizationId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateWebhookSchema)) body: UpdateWebhookInput,
  ) {
    return this.webhookService.update(organizationId, id, body);
  }

  @Post(':id/rotate-secret')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @AuditAction('WEBHOOK_SECRET_ROTATED')
  @ApiOperation({
    summary: 'Rotate the signing secret (returned once)',
    description:
      'Generates a new HMAC signing secret for the webhook. The old secret is immediately invalidated. ' +
      'The new secret is returned exactly once.',
  })
  @ApiParam({ name: 'id', description: 'Webhook UUID', example: '018f0a1b-...' })
  @ApiResponse({
    status: 200,
    description: 'New signing secret generated',
    type: WebhookSecretDto,
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  rotate(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.webhookService.rotateSecret(organizationId, id);
  }

  @Delete(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @AuditAction('WEBHOOK_DELETED')
  @ApiOperation({
    summary: 'Delete a webhook',
    description:
      'Permanently deletes the webhook and invalidates its signing secret. This action cannot be undone.',
  })
  @ApiParam({ name: 'id', description: 'Webhook UUID', example: '018f0a1b-...' })
  @ApiResponse({ status: 200, description: 'Webhook deleted successfully' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  remove(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.webhookService.remove(organizationId, id);
  }
}
