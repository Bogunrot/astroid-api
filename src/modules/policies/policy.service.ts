import { Injectable } from '@nestjs/common';
import { Policy } from '@prisma/client';

import { PaginationQuery } from '../../common/helpers/pagination';
import { Paginated } from '../../common/interfaces/api-response.interface';
import { EventBusService } from '../../events/event-bus.service';
import { DomainEventName } from '../../events/event-names';
import { PolicyEngine } from './policy.engine';
import { CreatePolicyInput, SimulatePolicyInput, UpdatePolicyInput } from './policy.dto';
import {
  EvaluablePolicy,
  PolicyConfiguration,
  PolicyEvaluationResult,
  TransactionIntent,
} from './policy.types';
import { SpendingPolicyService } from './spending-policy.service';

/**
 * Public entry point for policy definitions and evaluation.
 *
 * Persistence lives in {@link SpendingPolicyService} (backed by
 * `SpendingPolicyRepository`); this service adds the cross-cutting concerns the
 * rest of the platform expects — domain events on every mutation and the pure
 * {@link PolicyEngine} evaluation used by the payment pipeline.
 */
@Injectable()
export class PolicyService {
  constructor(
    private readonly spendingPolicies: SpendingPolicyService,
    private readonly engine: PolicyEngine,
    private readonly eventBus: EventBusService,
  ) {}

  async create(organizationId: string, actorId: string, input: CreatePolicyInput): Promise<Policy> {
    const policy = await this.spendingPolicies.create(organizationId, input);
    await this.eventBus.emit(
      DomainEventName.PolicyCreated,
      { policyId: policy.id, name: policy.name, type: policy.type },
      { organizationId, actorId, aggregateType: 'policy', aggregateId: policy.id },
    );
    return policy;
  }

  list(organizationId: string, query: PaginationQuery): Promise<Paginated<Policy>> {
    return this.spendingPolicies.list(organizationId, query);
  }

  getOrThrow(organizationId: string, id: string): Promise<Policy> {
    return this.spendingPolicies.getOrThrow(organizationId, id);
  }

  async update(
    organizationId: string,
    actorId: string,
    id: string,
    input: UpdatePolicyInput,
  ): Promise<Policy> {
    const policy = await this.spendingPolicies.update(organizationId, id, input);
    await this.eventBus.emit(
      DomainEventName.PolicyUpdated,
      { policyId: id },
      { organizationId, actorId, aggregateType: 'policy', aggregateId: id },
    );
    return policy;
  }

  async remove(
    organizationId: string,
    actorId: string,
    id: string,
  ): Promise<{ id: string; deleted: true }> {
    const result = await this.spendingPolicies.remove(organizationId, id);
    await this.eventBus.emit(
      DomainEventName.PolicyDeleted,
      { policyId: id },
      { organizationId, actorId, aggregateType: 'policy', aggregateId: id },
    );
    return result;
  }

  /**
   * Evaluates an intent against all applicable stored policies. Emits a
   * PolicyEvaluated event (and PolicyViolated on failure) for the ledger and
   * appends the outcome to the compliance audit trail.
   */
  async evaluateIntent(
    intent: TransactionIntent,
    actorId?: string,
  ): Promise<PolicyEvaluationResult> {
    const policies = await this.spendingPolicies.listActiveForEvaluation(
      intent.organizationId,
      intent.agentId,
    );
    const result = this.engine.evaluate(intent, policies.map(toEvaluable));

    await this.eventBus.emit(
      DomainEventName.PolicyEvaluated,
      {
        passed: result.passed,
        requiresApproval: result.requiresApproval,
        violations: result.violations.map((v) => v.code),
        amount: intent.amount,
        asset: intent.asset,
        recipientAddress: intent.recipientAddress,
      },
      {
        organizationId: intent.organizationId,
        actorId,
        aggregateType: 'policy',
        aggregateId: result.matchedPolicyId,
      },
    );

    if (!result.passed) {
      await this.eventBus.emit(
        DomainEventName.PolicyViolated,
        { violations: result.violations },
        {
          organizationId: intent.organizationId,
          actorId,
          aggregateType: 'policy',
          aggregateId: result.matchedPolicyId,
        },
      );
    }

    if (actorId) {
      await this.spendingPolicies.recordEvaluationAudit(intent, result, actorId);
    }

    return result;
  }

  /** POST /policies/simulate — dry run without creating a transaction. */
  async simulate(organizationId: string, input: SimulatePolicyInput) {
    const intent: TransactionIntent = {
      organizationId,
      agentId: input.agentId,
      walletId: input.walletId,
      asset: input.asset,
      amount: input.amount,
      recipientAddress: input.recipientAddress,
      spentToday: input.spentToday,
      spentThisWeek: input.spentThisWeek,
      spentThisMonth: input.spentThisMonth,
    };
    const policies = await this.spendingPolicies.listActiveForEvaluation(
      organizationId,
      input.agentId,
    );
    const result = this.engine.evaluate(intent, policies.map(toEvaluable));
    return {
      passed: result.passed,
      requiresApproval: result.requiresApproval,
      violations: result.violations,
      evaluatedPolicies: result.evaluatedPolicyIds.length,
    };
  }

  /**
   * Circuit breaker against rapid wallet draining: rejects the pending spend
   * when it would push the agent past its rolling 24-hour limit.
   * The organization and actor arguments are accepted for the transaction
   * pipeline's governance signature; the spending-policy service owns the
   * actual velocity calculation.
   */
  checkVelocityLimit(
    _organizationId: string,
    agentId: string,
    amount: number,
    assetCode: string,
    _actorId?: string,
  ): Promise<void> {
    return this.spendingPolicies.checkVelocityLimit(agentId, amount, assetCode);
  }
}

/** Projects a Prisma Policy into the engine's decoupled EvaluablePolicy shape. */
function toEvaluable(policy: Policy): EvaluablePolicy {
  return {
    id: policy.id,
    name: policy.name,
    priority: policy.priority,
    enabled: policy.enabled,
    agentId: policy.agentId,
    configuration: (policy.configuration as PolicyConfiguration) ?? {},
    overrideLimit: policy.overrideLimit?.toNumber() ?? null,
    overrideUntil: policy.overrideUntil,
    originalLimit: policy.originalLimit?.toNumber() ?? null,
  };
}
