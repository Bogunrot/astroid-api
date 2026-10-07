import { ExecutionContext, Injectable } from '@nestjs/common';
import {
  ThrottlerGuard,
  ThrottlerLimitDetail,
  ThrottlerRequest,
} from '@nestjs/throttler';
import { createHash } from 'crypto';
import { Request, Response } from 'express';

import { THROTTLE_TIER_KEY, ThrottleTier } from '../decorators/throttle-tier.decorator';
import { extractApiKeyFromRequest } from '../helpers/extract-api-key';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

/** Request-scoped view the tracker/lookup helpers work against. */
type ThrottledRequest = Request & { user?: AuthenticatedUser };

/**
 * Redis-backed rate-limit guard for high-frequency agent endpoints.
 *
 * Extends `@nestjs/throttler`'s `ThrottlerGuard` (counters therefore live in the
 * shared `RedisThrottlerStorage` when the module is configured with one) and
 * adds two behaviours the autonomous-agent workload needs:
 *
 *  1. **Agent-aware tracking.** The counter key is derived from the acting
 *     agent (`x-agent-id`, a route/body/query `agentId`, or an API-key
 *     principal) instead of the organization or IP, so one noisy agent can
 *     never exhaust another agent's budget behind the same NAT/gateway.
 *  2. **Tier routing.** Only the named throttler matching the route's tier is
 *     enforced: `agent` for agent-identified traffic, `auth` for routes marked
 *     `@ThrottleTierDecorator('auth')`, `api` for everything else.
 *
 * Unauthenticated calls fall back to a hashed API key and finally to the client
 * IP (honouring `x-forwarded-for`), which keeps public routes protected.
 *
 * Every rejection is a standard HTTP 429 that also carries the plain
 * `Retry-After`, `X-RateLimit-Limit` and `X-RateLimit-Remaining` headers.
 */
@Injectable()
export class AgentThrottlerGuard extends ThrottlerGuard {
  /** Enforce only the throttler that governs this route's tier. */
  protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const { context, throttler, limit } = requestProps;
    const routeTier = this.resolveTier(context);

    // This named throttler does not govern this route's tier — do not count it.
    if (throttler.name !== routeTier) {
      return true;
    }

    // Publish the tier limit up-front so even a successful call advertises the
    // budget it consumed (the library's per-throttler headers are also set).
    context.switchToHttp().getResponse<Response>().setHeader('X-RateLimit-Limit', limit);

    return super.handleRequest(requestProps);
  }

  /**
   * Buckets a request by acting agent, then organization, then API key, then IP.
   * Never stores a raw credential: the API-key fallback is hashed.
   */
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const request = req as unknown as ThrottledRequest;

    const agentId = this.resolveAgentId(request);
    if (agentId) {
      return `agent:${agentId}`;
    }

    if (request.user?.organizationId) {
      return `org:${request.user.organizationId}`;
    }

    const apiKey = extractApiKeyFromRequest(request);
    if (apiKey) {
      return `key:${createHash('sha256').update(apiKey).digest('hex')}`;
    }

    return `ip:${this.resolveIp(request)}`;
  }

  /** Adds the plain rate-limit headers before the library throws its 429. */
  protected async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const response = context.switchToHttp().getResponse<Response>();
    response.setHeader('Retry-After', detail.timeToBlockExpire);
    response.setHeader('X-RateLimit-Limit', detail.limit);
    response.setHeader('X-RateLimit-Remaining', Math.max(0, detail.limit - detail.totalHits));

    await super.throwThrottlingException(context, detail);
  }

  /**
   * Resolves the tier to enforce. An explicit `@ThrottleTierDecorator()` always
   * wins; otherwise agent-identified traffic is routed to the `agent` tier and
   * everything else to `api`.
   */
  private resolveTier(context: ExecutionContext): ThrottleTier {
    const declared = this.reflector.getAllAndOverride<ThrottleTier | undefined>(THROTTLE_TIER_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (declared) {
      return declared;
    }

    const request = context.switchToHttp().getRequest<ThrottledRequest>();
    return this.resolveAgentId(request) ? 'agent' : 'api';
  }

  /**
   * Extracts the acting agent id from any of the places the platform carries it:
   * route params, body, query, the `x-agent-id` header, or an API-key principal
   * bound to an agent (`user.id` of an `isApiKey` principal).
   */
  private resolveAgentId(request: ThrottledRequest): string | undefined {
    const fromRequest =
      (request.params?.agentId as string) ||
      ((request.body as Record<string, unknown> | undefined)?.agentId as string) ||
      ((request.query as Record<string, unknown> | undefined)?.agentId as string) ||
      (request.headers?.['x-agent-id'] as string) ||
      undefined;

    if (fromRequest) {
      return fromRequest;
    }

    // An API-key principal acts on behalf of an agent in this platform.
    if (request.user?.isApiKey && request.user.id) {
      return request.user.id;
    }

    return undefined;
  }

  /** Trusts `x-forwarded-for` for tracker bucketing, then falls back to the socket IP. */
  private resolveIp(request: ThrottledRequest): string {
    const forwarded = request.headers?.['x-forwarded-for'];
    const header = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return header ?? request.ip ?? request.socket?.remoteAddress ?? 'anonymous';
  }
}
