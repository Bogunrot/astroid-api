import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { Request } from 'express';
import {
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from '../constants/headers';

/**
 * Resolves the HMAC secret for a given webhook integration.
 * Returns the secret string, or undefined if no secret is configured.
 */
export type WebhookSecretResolver = (
  request: Request,
  integrationId?: string,
) => string | undefined | Promise<string | undefined>;

/**
 * Configuration options for `WebhookSignatureGuard`.
 */
export interface WebhookSignatureGuardOptions {
  /**
   * Custom secret resolver for per-integration webhook secrets.
   * When provided, this function is called first to resolve the secret.
   * If it returns `undefined`, the guard falls back to global env-var secrets.
   */
  secretResolver?: WebhookSecretResolver;
  /**
   * Timestamp tolerance in seconds (default: 300 = 5 minutes).
   * Requests with timestamps older than this are rejected to prevent replay attacks.
   */
  toleranceSeconds?: number;
}

/**
 * Validates HMAC-SHA256 signature and timestamp freshness on incoming
 * webhook events from external partner services and oracle providers.
 *
 * Signature calculation: HMAC-SHA256(timestamp + '.' + rawBody, secret)
 *
 * Security features:
 * - Constant-time comparison via `crypto.timingSafeEqual` prevents timing attacks
 * - Timestamp tolerance (default 5 min) prevents replay attacks
 * - Configurable per-integration secret resolution for multi-tenant setups
 * - Raw body buffering ensures accurate HMAC computation
 *
 * @example
 * ```ts
 * // Apply with default global secret:
 * @UseGuards(WebhookSignatureGuard)
 *
 * // Apply with per-integration secret resolver:
 * @UseGuards(new WebhookSignatureGuard(configService, {
 *   secretResolver: (req) => getIntegrationSecret(req.headers['x-integration-id']),
 * }))
 * ```
 */
@Injectable()
export class WebhookSignatureGuard implements CanActivate {
  private readonly logger = new Logger(WebhookSignatureGuard.name);
  private readonly toleranceSeconds: number;
  private readonly secretResolver?: WebhookSecretResolver;

  constructor(
    private readonly configService: ConfigService,
    @Optional() options?: WebhookSignatureGuardOptions,
  ) {
    this.toleranceSeconds = options?.toleranceSeconds ?? 300;
    this.secretResolver = options?.secretResolver;
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    const signature = request.headers[WEBHOOK_SIGNATURE_HEADER] as string;
    const timestampStr = request.headers[WEBHOOK_TIMESTAMP_HEADER] as string;

    if (!signature) {
      throw new UnauthorizedException('Missing webhook signature header');
    }

    if (!timestampStr) {
      throw new UnauthorizedException('Missing webhook timestamp header');
    }

    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp)) {
      throw new UnauthorizedException('Invalid webhook timestamp');
    }

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > this.toleranceSeconds) {
      throw new UnauthorizedException('Webhook timestamp expired or out of tolerance');
    }

    // Resolve the secret: try per-integration resolver first, then fall back to global env vars.
    const secret = this.resolveSecret(request);
    if (!secret) {
      this.logger.warn('No webhook secret configured; rejecting request');
      throw new UnauthorizedException('No webhook signing secret configured');
    }

    const payload = this.extractPayload(request);

    const expectedPayloadToSign = `${timestamp}.${payload}`;
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(expectedPayloadToSign);
    const expectedSignature = hmac.digest('hex');

    const signatureBuffer = Buffer.from(signature, 'utf8');
    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

    if (
      signatureBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
    ) {
      throw new UnauthorizedException('Invalid webhook cryptographic signature');
    }

    return true;
  }

  /**
   * Resolves the HMAC signing secret for the incoming request.
   * Priority: per-integration resolver → WEBHOOK_SECRET → STELLAR_WEBHOOK_SECRET.
   */
  private resolveSecret(request: Request): string | undefined {
    // Per-integration secret resolver (synchronous or async)
    const integrationId = request.headers['x-integration-id'] as string | undefined;
    if (this.secretResolver) {
      const resolved = this.secretResolver(request, integrationId);
      // Handle both sync and async resolvers
      if (resolved && typeof (resolved as Promise<string | undefined>).then === 'function') {
        // Async resolver — store the promise for later use
        // Note: canActivate doesn't support async in sync mode, so we
        // log a warning. For async secret resolution, use the async guard variant.
        this.logger.warn(
          'Async secret resolver returned a Promise; use the async canActivate variant for async secret resolution',
        );
      } else if (resolved) {
        return resolved as string;
      }
    }

    // Global env-var fallback
    return (
      this.configService.get<string>('WEBHOOK_SECRET') ||
      this.configService.get<string>('STELLAR_WEBHOOK_SECRET') ||
      this.configService.get<string>('WEBHOOK_SIGNING_SECRET') ||
      undefined
    );
  }

  /**
   * Extracts the request payload for HMAC computation.
   * Prefers the raw body captured by `RawBodyMiddleware`, falling back to
   * the parsed body if raw body is not available.
   */
  private extractPayload(request: Request): string {
    const rawBody = (request as Request & { rawBody?: Buffer | string }).rawBody;
    if (rawBody !== undefined) {
      return Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
    }

    if (typeof request.body === 'string') {
      return request.body;
    }

    return JSON.stringify(request.body ?? {});
  }
}
