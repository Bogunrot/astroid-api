import { Injectable } from '@nestjs/common';
import { Policy } from '@prisma/client';
import { SpendingPolicyService } from './spending-policy.service';
import { PolicyEngine } from './policy.engine';
import { CreatePolicyInput, SimulatePolicyInput, UpdatePolicyInput } from './policy.dto';
import { EvaluablePolicy, PolicyConfiguration, PolicyEvaluationResult, TransactionIntent } from './policy.types';
import { PaginationQuery } from '../../common/helpers/pagination';
import { EventBusService } from '../../events/event-bus.service';
import { DomainEventName } from '../../events/event-names';

/**
 * Controller-facing façade over the policy domain. Delegates persistence and
 * spending-policy enforcement to {@link SpendingPolicyService} and wraps every
 * mutation with the domain events the audit ledger depends on.
 */
@Injectable()
export class PolicyService {
  constructor(
    private readonly spendingPolicyService: SpendingPolicyService,
    private readonly engine: PolicyEngine,
    private readonly eventBus: EventBusService,
  ) {}

  async create(organizationId: string, actorId: string, input: CreatePolicyInput) {
    const policy = await this.spendingPolicyService.create(organizationId, input);
    await this.eventBus.emit(
      DomainEventName.PolicyCreated,
      { policyId: policy.id, name: policy.name, type: policy.type },
      { organizationId, actorId, aggregateType: 'policy', aggregateId: policy.id },
    );
    return policy;
  }

  list(organizationId: string, query: PaginationQuery) {
    return this.spendingPolicyService.list(organizationId, query);
  }

  getOrThrow(organizationId: string, id: string): Promise<Policy> {
    return this.spendingPolicyService.getOrThrow(organizationId, id);
  }

  async update(organizationId: string, actorId: string, id: string, input: UpdatePolicyInput) {
    const policy = await this.spendingPolicyService.update(organizationId, id, input);
    await this.eventBus.emit(
      DomainEventName.PolicyUpdated,
      { policyId: id },
      { organizationId, actorId, aggregateType: 'policy', aggregateId: id },
    );
    return policy;
  }

  async remove(organizationId: string, actorId: string, id: string) {
    const result = await this.spendingPolicyService.remove(organizationId, id);
    await this.eventBus.emit(
      DomainEventName.PolicyDeleted,
      { policyId: id },
      { organizationId, actorId, aggregateType: 'policy', aggregateId: id },
    );
    return result;
  }

  /**
   * Evaluates an intent against all applicable stored policies. Emits a
   * PolicyEvaluated event (and PolicyViolated on failure) for the ledger.
   * Also persists an audit log entry for compliance tracking.
   */
  async evaluateIntent(
    intent: TransactionIntent,
    actorId?: string,
  ): Promise<PolicyEvaluationResult> {
    const policies = await this.spendingPolicyService.listActiveForEvaluation(
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
      await this.spendingPolicyService.recordEvaluationAudit(intent, result, actorId);
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
    const policies = await this.spendingPolicyService.listActiveForEvaluation(organizationId, input.agentId);
    const result = this.engine.evaluate(intent, policies.map(toEvaluable));
    return {
      passed: result.passed,
      requiresApproval: result.requiresApproval,
      violations: result.violations,
      evaluatedPolicies: result.evaluatedPolicyIds.length,
    };
  }

  /**
   * Checks the rolling 24-hour velocity limit for an agent's spending. Acts as
   * a circuit breaker to prevent rapid draining of wallets. Delegates the
   * actual enforcement to {@link SpendingPolicyService}; `organizationId` and
   * `actorId` are accepted for call-site symmetry with the rest of the
   * transaction governance pipeline but are not needed by the check itself.
   */
  checkVelocityLimit(
    _organizationId: string,
    agentId: string,
    amount: number,
    assetCode: string,
    _actorId?: string,
  ): Promise<void> {
    return this.spendingPolicyService.checkVelocityLimit(agentId, amount, assetCode);
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
