import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { SkipAudit } from '../../common/decorators/skip-audit.decorator';
import { WebhookSignatureGuard } from '../../common/guards/webhook-signature.guard';
import {
  SlidingWindowThrottlerGuard,
  SlidingWindowLimit,
} from '../../common/guards/sliding-window-throttler.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { incomingWebhookSchema, IncomingWebhookInput } from './webhook-ingress.dto';
import { WebhookIngressService } from './webhook-ingress.service';

/**
 * Receives inbound webhook events from external partner services and oracle
 * providers. Unauthenticated (no JWT/API key — the sender is external), so
 * this route is protected instead by HMAC signature verification and a
 * Redis-backed sliding-window rate limit.
 */
@ApiExcludeController()
@Controller('webhooks')
@Public()
@SkipAudit()
export class WebhookIngressController {
  constructor(private readonly ingressService: WebhookIngressService) {}

  @Post('receive')
  @HttpCode(202)
  @UseGuards(WebhookSignatureGuard, SlidingWindowThrottlerGuard)
  @SlidingWindowLimit(60, 60)
  async receive(
    @Body(new ZodValidationPipe(incomingWebhookSchema)) body: IncomingWebhookInput,
  ): Promise<{ received: true }> {
    await this.ingressService.handle(body);
    return { received: true };
  }
}
