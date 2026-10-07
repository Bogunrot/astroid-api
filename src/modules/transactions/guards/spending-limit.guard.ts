import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AuthenticatedUser } from '../../../common/interfaces/authenticated-user.interface';
import { SpendingLimitService } from '../spending-limit.service';
import { TransactionIntent } from '../../policies/policy.types';

export const SPENDING_LIMIT_GUARD_KEY = 'astroid:spendingLimitGuard';

/**
 * Decorator that enables spending limit evaluation on a route.
 * Apply to transaction creation endpoints that carry an optional `agentId`.
 *
 * ```typescript
 * @Post()
 * @UseGuards(SpendingLimitGuard)
 * @RequireSpendingLimitCheck()
 * create(...) { ... }
 * ```
 */
export const RequireSpendingLimitCheck = () => SetMetadata(SPENDING_LIMIT_GUARD_KEY, true);

/**
 * NestJS guard that intercepts transaction creation requests and evaluates them
 * against the agent's configured spending-limit policies (daily/weekly/monthly
 * budget caps) before the request reaches the service layer.
 *
 * Design decisions:
 *  - Only activated when the `@RequireSpendingLimitCheck()` decorator is
 *    present on the handler — routes without it pass straight through.
 *  - If no `agentId` is present in the request body the guard is a no-op,
 *    because periodic spending limits are scoped to agents.
 *  - Uses {@link SpendingLimitService.evaluateSpendingLimits} which runs
 *    aggregate queries inside a Prisma transaction to prevent race conditions
 *    when multiple concurrent requests target the same agent budget.
 *  - On violation: throws {@link PolicyViolationException} (HTTP 422) with a
 *    structured payload listing every violated policy. The global
 *    {@link AllExceptionsFilter} converts this to an RFC 9457 problem-details
 *    body so clients receive a consistent, machine-readable error shape:
 *
 *    ```json
 *    {
 *      "type": "urn:astroid:problem:policy-violation",
 *      "title": "Policy Violation",
 *      "status": 422,
 *      "code": "POLICY_VIOLATION",
 *      "detail": "Transaction blocked by spending limit policy: ...",
 *      "details": { "violations": [...], "aggregates": {...} }
 *    }
 *    ```
 *
 * Guard execution order (APP_GUARD chain + route guards):
 *   PublicRateLimitGuard → JwtAuthGuard → RolesGuard → ScopesGuard →
 *   AstroidThrottlerGuard → SpendingLimitGuard (route-level, via @UseGuards)
 */
@Injectable()
export class SpendingLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly spendingLimitService: SpendingLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Only evaluate when the handler explicitly opts in via the decorator.
    const enabled = this.reflector.getAllAndOverride<boolean>(SPENDING_LIMIT_GUARD_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!enabled) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();

    const body = request.body as Record<string, unknown> | undefined;
    const agentId = body?.agentId as string | undefined;

    // No agent attached to this transaction — periodic limits do not apply.
    if (!agentId) {
      return true;
    }

    const organizationId = request.user?.organizationId;
    if (!organizationId) {
      // Guard can only evaluate when we know which org's policies to load.
      // JwtAuthGuard runs before this so a missing org here means the route
      // is @Public() and spending limits are not enforced.
      return true;
    }

    const actorId = request.user?.id;
    const amount = Number(body?.amount ?? 0);
    const asset = (body?.asset as string) ?? 'XLM';
    const recipientAddress = (body?.recipientAddress as string) ?? '';
    const walletId = (body?.walletId as string) ?? undefined;

    const intent: TransactionIntent = {
      organizationId,
      agentId,
      walletId,
      asset,
      amount,
      recipientAddress,
      at: new Date(),
    };

    // evaluateSpendingLimits throws PolicyViolationException on failure and
    // returns void on success — the guard returns true on success.
    await this.spendingLimitService.evaluateSpendingLimits(intent, actorId);

    return true;
  }
}
