import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PolicyService } from '../policy.service';
import { TransactionIntent } from '../policy.types';
import { PolicyViolationException } from '../../../common/exceptions/domain.exception';
import { AGENT_POLICY_KEY } from '../decorators/agent-policy.decorator';

/**
 * Guard that enforces agent spending policies before transaction execution.
 * Validates transaction requests against active spending policies including:
 * - Daily and per-transaction amount limits
 * - Allowed/blocked assets
 * - Whitelisted/blacklisted destination addresses
 * - Emergency lock status
 *
 * Uses Reflector to check for @RequireAgentPolicy decorator and enables
 * policy enforcement only when the decorator is present.
 */
@Injectable()
export class AgentPolicyGuard implements CanActivate {
  constructor(
    private readonly policyService: PolicyService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if the route requires agent policy enforcement
    const requirePolicy = this.reflector.getAllAndOverride<boolean>(AGENT_POLICY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Skip if the decorator is not present
    if (!requirePolicy) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const body = request.body;

    // Extract transaction metadata from request body
    const agentId = body.agentId || request.user?.agentId;
    const walletId = body.walletId;
    const amount = body.amount;
    const asset = body.asset;
    const recipientAddress = body.recipientAddress;
    const organizationId = request.user?.organizationId || body.organizationId;

    // Skip validation if no agent ID is present (e.g., organization-level operations)
    if (!agentId) {
      return true;
    }

    // Build transaction intent for policy evaluation
    const intent: TransactionIntent = {
      organizationId,
      agentId,
      walletId,
      asset,
      amount: Number(amount),
      recipientAddress,
    };

    try {
      // Evaluate against all applicable policies
      const result = await this.policyService.evaluateIntent(intent);

      if (!result.passed) {
        // Build detailed error message from violations
        const violationMessages = result.violations.map((v) => `${v.policyName}: ${v.message}`).join('; ');
        throw new PolicyViolationException(
          `Transaction violates spending policy: ${violationMessages}`,
          {
            violations: result.violations,
            requiresApproval: result.requiresApproval,
          },
        );
      }

      // Check velocity limits (rolling 24-hour window)
      const actorId = request.user?.isApiKey
        ? request.user.createdById ?? undefined
        : request.user?.id;
      await this.policyService.checkVelocityLimit(
        organizationId,
        agentId,
        Number(amount),
        asset,
        actorId,
      );

      return true;
    } catch (error) {
      if (error instanceof PolicyViolationException) {
        throw error;
      }
      // Re-throw other exceptions (e.g., velocity limit exceeded)
      throw error;
    }
  }
}
