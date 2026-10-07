import { Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerRequest } from '@nestjs/throttler';
import { Request } from 'express';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { THROTTLE_TIER_KEY, ThrottleTier } from '../decorators/throttle-tier.decorator';

/**
 * Rate-limit guard with per-tier steady-state and burst throttlers.
 *
 * Each route is evaluated against every registered named throttler, but a
 * throttler fires only when its name matches the route's declared tier:
 *
 *  - A throttler named `'api'` fires only on `api`-tier routes.
 *  - A throttler named `'api-burst'` fires only on `api`-tier routes
 *    (the `-burst` suffix is stripped for comparison).
 *  - Routes without an explicit `@ThrottleTierDecorator` default to `api`.
 *
 * This means auth endpoints (marked `@ThrottleTierDecorator('auth')`) get the
 * stricter steady-state limit **and** the tighter burst limit, while everything
 * else is governed by the `api` pair.
 *
 * The counter is scoped to the authenticated organization, falling back to the
 * client IP for anonymous requests (e.g. auth endpoints before login).
 */
@Injectable()
export class AstroidThrottlerGuard extends ThrottlerGuard {
  /**
   * Enforce a named throttler only when its base tier matches the route's
   * declared tier. The base tier of `'api-burst'` is `'api'`, so the burst
   * throttler fires on the same set of routes as its steady-state counterpart.
   */
  protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const { context, throttler } = requestProps;
    const routeTier =
      this.reflector.getAllAndOverride<ThrottleTier>(THROTTLE_TIER_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'api';

    // Strip the optional `-burst` suffix to get the base tier name.
    const throttlerBaseTier = throttler.name?.replace(/-burst$/, '') as ThrottleTier | undefined;

    // This named throttler does not govern this route's tier — do not count it.
    if (throttlerBaseTier !== routeTier) {
      return true;
    }

    return super.handleRequest(requestProps);
  }

  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const request = req as unknown as Request & {
      user?: AuthenticatedUser;
      apiKey?: { id: string };
    };
    const apiKeyHeader = request.headers['x-api-key'];
    const apiKeyId =
      request.apiKey?.id ??
      (Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader);
    if (apiKeyId) {
      return `apikey:${apiKeyId}`;
    }
    const sub = request.user?.sub ?? request.user?.id;
    if (sub) {
      return `user:${sub}`;
    }
    const org = request.user?.organizationId;
    if (org) {
      return `org:${org}`;
    }
    const forwarded = request.headers?.['x-forwarded-for'];
    const ip =
      (Array.isArray(forwarded) ? forwarded[0] : forwarded) ??
      request.ip ??
      request.socket?.remoteAddress ??
      'anonymous';
    return `ip:${ip}`;
  }
}
