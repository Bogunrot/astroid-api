import { Injectable, Logger } from '@nestjs/common';
import { Policy, Prisma } from '@prisma/client';

import {
  NotFoundException,
  ValidationException,
  VelocityLimitExceededException,
} from '../../common/exceptions/domain.exception';
import {
  buildPaginationMeta,
  PaginationQuery,
  toPrismaPagination,
} from '../../common/helpers/pagination';
import { Paginated } from '../../common/interfaces/api-response.interface';
import { formatZodError } from '../../common/validators/zod-error';
import { CreatePolicyInput, UpdatePolicyInput } from './policy.dto';
import {
  PolicyConfiguration,
  PolicyEvaluationResult,
  TransactionIntent,
  policyConfigurationSchemaStrict,
} from './policy.types';
import { SpendingPolicyRepository } from './spending-policy.repository';

/** Fields a caller may sort the policy list by. */
const SORTABLE = ['createdAt', 'priority', 'name', 'type'];

/** Rolling window used by the velocity (drain-prevention) check. */
const VELOCITY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Owns the agent spending-policy domain: validation, persistence orchestration
 * and the enforcement helpers the transaction pipeline depends on.
 *
 * The service never touches Prisma — every read and write goes through
 * {@link SpendingPolicyRepository}, which keeps the persistence layer swappable
 * and makes this class fully unit-testable with a mocked repository.
 */
@Injectable()
export class SpendingPolicyService {
  private readonly logger = new Logger(SpendingPolicyService.name);

  constructor(private readonly repository: SpendingPolicyRepository) {}

  /** Validates and persists a new spending policy. */
  async create(organizationId: string, input: CreatePolicyInput): Promise<Policy> {
    const configuration = this.validateConfiguration(input.configuration);

    return this.repository.create({
      organization: { connect: { id: organizationId } },
      ...(input.agentId ? { agent: { connect: { id: input.agentId } } } : {}),
      name: input.name,
      description: input.description,
      type: input.type,
      configuration,
      priority: input.priority,
      enabled: input.enabled,
    });
  }

  /** Paginated policy list for one organization. */
  async list(organizationId: string, query: PaginationQuery): Promise<Paginated<Policy>> {
    const where: Prisma.PolicyWhereInput = { organizationId, deletedAt: null };
    if (query.search) {
      where.name = { contains: query.search, mode: 'insensitive' };
    }
    const pagination = toPrismaPagination(query, SORTABLE);
    const { items, total } = await this.repository.findManyAndCount(where, pagination);
    return new Paginated(items, buildPaginationMeta(total, query));
  }

  /** Returns a policy or throws a 404 when it does not exist in the organization. */
  async getOrThrow(organizationId: string, id: string): Promise<Policy> {
    const policy = await this.repository.findById(organizationId, id);
    if (!policy) {
      throw new NotFoundException('Policy', id);
    }
    return policy;
  }

  /** Validates and applies a partial update to an existing policy. */
  async update(
    organizationId: string,
    id: string,
    input: UpdatePolicyInput,
  ): Promise<Policy> {
    await this.getOrThrow(organizationId, id);

    const data: Prisma.PolicyUpdateInput = {
      name: input.name,
      description: input.description,
      type: input.type,
      priority: input.priority,
      enabled: input.enabled,
    };
    if (input.configuration) {
      data.configuration = this.validateConfiguration(input.configuration);
    }

    return this.repository.update(id, data);
  }

  /** Soft-deletes a policy after confirming it belongs to the organization. */
  async remove(organizationId: string, id: string): Promise<{ id: string; deleted: true }> {
    await this.getOrThrow(organizationId, id);
    await this.repository.softDelete(id);
    return { id, deleted: true };
  }

  /** Enabled policies that apply to an organization and, optionally, an agent. */
  listActiveForEvaluation(organizationId: string, agentId?: string) {
    return this.repository.findActiveForEvaluation(organizationId, agentId);
  }

  /** Validates a policy configuration against the strict spending-policy schema. */
  private validateConfiguration(
    configuration: CreatePolicyInput['configuration'],
  ): Prisma.InputJsonValue {
    const validationResult = policyConfigurationSchemaStrict.safeParse(configuration);
    if (!validationResult.success) {
      throw new ValidationException(
        'Invalid policy configuration',
        formatZodError(validationResult.error),
      );
    }
    return validationResult.data as Prisma.InputJsonValue;
  }

  /**
   * Enforces the rolling 24-hour velocity limit for an agent: the spend already
   * settled in the window plus the pending amount must stay within the agent's
   * configured `dailyLimit`. Acts as a circuit breaker against rapid wallet
   * draining. Agents without a daily-limit policy are unlimited.
   */
  async checkVelocityLimit(agentId: string, amount: number, assetCode: string): Promise<void> {
    const limitPolicy = await this.findDailyLimitPolicy(agentId);
    if (!limitPolicy) {
      return;
    }
    const dailyLimit = limitPolicy.configuration.dailyLimit!;

    const spentInWindow = await this.repository.sumSpentInWindow({
      agentId,
      assetCode,
      since: new Date(Date.now() - VELOCITY_WINDOW_MS),
    });

    if (spentInWindow + amount > dailyLimit) {
      throw new VelocityLimitExceededException(
        `Daily velocity limit exceeded. Spent: ${spentInWindow}, Pending: ${amount}, Limit: ${dailyLimit}`,
        { spentInWindow, pendingAmount: amount, limit: dailyLimit, assetCode },
      );
    }
  }

  /** Highest-priority agent policy that declares a positive `dailyLimit`, if any. */
  private async findDailyLimitPolicy(
    agentId: string,
  ): Promise<{ configuration: PolicyConfiguration } | undefined> {
    const policies = await this.repository.findActiveForEvaluationByAgent(agentId);
    const limitPolicy = policies.find((policy) => {
      const configuration = (policy.configuration as PolicyConfiguration) ?? {};
      return configuration.dailyLimit !== undefined && configuration.dailyLimit > 0;
    });
    return limitPolicy
      ? { configuration: (limitPolicy.configuration as PolicyConfiguration) ?? {} }
      : undefined;
  }

  /**
   * Appends the outcome of a policy evaluation to the audit trail. Compliance
   * bookkeeping must never block the payment pipeline, so failures are logged
   * and swallowed.
   */
  async recordEvaluationAudit(
    intent: TransactionIntent,
    result: PolicyEvaluationResult,
    actorId: string,
  ): Promise<void> {
    try {
      await this.repository.recordEvaluationAudit({
        organizationId: intent.organizationId,
        userId: actorId,
        policyId: result.matchedPolicyId ?? null,
        payload: {
          passed: result.passed,
          requiresApproval: result.requiresApproval,
          violations: result.violations,
          transactionIntent: intent,
        } as unknown as Prisma.InputJsonValue,
      });
    } catch (error) {
      this.logger.error(
        `Failed to persist policy evaluation audit log: ${(error as Error).message}`,
      );
    }
  }
}
