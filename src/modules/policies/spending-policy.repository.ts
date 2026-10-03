import { Injectable, Logger } from '@nestjs/common';
import { Prisma, TransactionStatus } from '@prisma/client';

import { PrismaPagination } from '../../common/helpers/pagination';
import { PrismaService } from '../../database/prisma.service';

/** Transaction states that count as real, settled spend for velocity checks. */
export const SETTLED_TRANSACTION_STATUSES: readonly TransactionStatus[] = [
  TransactionStatus.COMPLETED,
  TransactionStatus.CONFIRMED,
];

/** Query describing the rolling spend window for one agent/asset pair. */
export interface SpendingWindowQuery {
  agentId: string;
  assetCode: string;
  since: Date;
  statuses?: readonly TransactionStatus[];
}

/** Fields persisted when a policy evaluation is appended to the audit trail. */
export interface PolicyEvaluationAuditInput {
  organizationId: string;
  userId: string;
  policyId?: string | null;
  payload: Prisma.InputJsonValue;
}

/**
 * Repository for agent spending policies.
 *
 * Every Prisma call that concerns a spending policy — creation, retrieval,
 * updates, soft deletes and the spend aggregation used by enforcement checks —
 * lives here, so services depend on a small, mockable surface instead of the
 * Prisma client itself.
 *
 * Behaviour every method shares:
 *  - **Uniform error handling.** Failures are logged once with the operation
 *    name (plus the Prisma error code when available) and rethrown, so callers
 *    keep seeing the original error while operators get a consistent trail.
 *  - **Transaction safety.** Composite reads run inside `$transaction`, and
 *    {@link withTransaction} exposes an interactive transaction for callers that
 *    need several writes to commit or roll back together.
 */
@Injectable()
export class SpendingPolicyRepository {
  private readonly logger = new Logger(SpendingPolicyRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Persists a new policy row. */
  create(data: Prisma.PolicyCreateInput) {
    return this.execute('create', () => this.prisma.policy.create({ data }));
  }

  /** Returns a live (non-deleted) policy scoped to its organization. */
  findById(organizationId: string, id: string) {
    return this.execute('findById', () =>
      this.prisma.policy.findFirst({ where: { id, organizationId, deletedAt: null } }),
    );
  }

  /** Enabled policies applicable to an organization, optionally agent-scoped. */
  findActiveForEvaluation(organizationId: string, agentId?: string) {
    return this.execute('findActiveForEvaluation', () =>
      this.prisma.policy.findMany({
        where: {
          organizationId,
          enabled: true,
          deletedAt: null,
          OR: [{ agentId: null }, ...(agentId ? [{ agentId }] : [])],
        },
        orderBy: { priority: 'asc' },
      }),
    );
  }

  /** Enabled policies bound to a single agent (used by velocity checks). */
  findActiveForEvaluationByAgent(agentId: string) {
    return this.execute('findActiveForEvaluationByAgent', () =>
      this.prisma.policy.findMany({
        where: { agentId, enabled: true, deletedAt: null },
        orderBy: { priority: 'asc' },
      }),
    );
  }

  /** Paginated policy list plus total count, read inside one transaction. */
  findManyAndCount(where: Prisma.PolicyWhereInput, pagination: PrismaPagination) {
    return this.execute('findManyAndCount', async () => {
      const [items, total] = await this.prisma.$transaction([
        this.prisma.policy.findMany({ where, ...pagination }),
        this.prisma.policy.count({ where }),
      ]);
      return { items, total };
    });
  }

  /** Applies a partial update to a policy row. */
  update(id: string, data: Prisma.PolicyUpdateInput) {
    return this.execute('update', () => this.prisma.policy.update({ where: { id }, data }));
  }

  /** Soft-deletes a policy: it stays queryable for audits but stops applying. */
  softDelete(id: string) {
    return this.execute('softDelete', () =>
      this.prisma.policy.update({
        where: { id },
        data: { deletedAt: new Date(), enabled: false },
      }),
    );
  }

  /**
   * Sums the amount an agent already spent for one asset since `since`.
   *
   * Aggregation happens in the client (rather than SQL) so `Decimal` handling
   * stays explicit and the method is trivially mockable in unit tests.
   */
  async sumSpentInWindow(query: SpendingWindowQuery): Promise<number> {
    return this.execute('sumSpentInWindow', async () => {
      const rows = await this.prisma.transaction.findMany({
        where: {
          agentId: query.agentId,
          asset: query.assetCode,
          status: { in: [...(query.statuses ?? SETTLED_TRANSACTION_STATUSES)] },
          createdAt: { gte: query.since },
        },
        select: { amount: true },
      });
      return rows.reduce((sum, row) => sum + Number(row.amount), 0);
    });
  }

  /** Appends a policy-evaluation entry to the immutable audit trail. */
  recordEvaluationAudit(input: PolicyEvaluationAuditInput) {
    return this.execute('recordEvaluationAudit', () =>
      this.prisma.auditLog.create({
        data: {
          organizationId: input.organizationId,
          userId: input.userId,
          action: 'POLICY_EVALUATED',
          entity: 'policy',
          entityId: input.policyId ?? null,
          oldValue: Prisma.JsonNull,
          newValue: input.payload,
        },
      }),
    );
  }

  /**
   * Runs `work` inside an interactive Prisma transaction so multi-step policy
   * mutations either commit together or roll back together.
   */
  withTransaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.execute('withTransaction', () => this.prisma.$transaction(work));
  }

  /** Single funnel for logging + rethrowing, keeping error handling uniform. */
  private async execute<T>(operation: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const code = error instanceof Prisma.PrismaClientKnownRequestError ? ` (${error.code})` : '';
      this.logger.error(
        `SpendingPolicyRepository.${operation} failed${code}: ${(error as Error).message}`,
      );
      throw error;
    }
  }
}
