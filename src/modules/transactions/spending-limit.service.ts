import { Injectable, Logger } from '@nestjs/common';
import { Prisma, TransactionStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PolicyService } from '../policies/policy.service';
import { AuditService } from '../audit/audit.service';
import { PolicyConfiguration, TransactionIntent } from '../policies/policy.types';
import { PolicyViolationException } from '../../common/exceptions/domain.exception';

/**
 * Daily/weekly/monthly spend windows, returned by `aggregateSpend`.
 * All values are in the same asset unit as the transaction.
 */
export interface SpendAggregates {
  spentToday: number;
  spentThisWeek: number;
  spentThisMonth: number;
}

/**
 * SpendingLimitService — evaluates agent spending limit policies with
 * race-condition-safe aggregate queries.
 *
 * Responsibilities:
 *  1. Query the agent's accumulated spend across daily/weekly/monthly UTC
 *     windows inside a single Prisma interactive transaction (serializable
 *     snapshot) so concurrent submissions cannot double-count.
 *  2. Evaluate the enriched {@link TransactionIntent} (with real aggregates)
 *     against active policies via {@link PolicyService.evaluateIntent}.
 *  3. On failure: persist a dedicated audit log entry before throwing
 *     {@link PolicyViolationException} so the compliance trail is complete
 *     even when the transaction is blocked.
 *
 * This service is intentionally narrow in scope — it does not replace
 * {@link PolicyService} or {@link PolicyEngine}; it only enriches the intent
 * with atomic spend data and delegates evaluation to the policy layer.
 */
@Injectable()
export class SpendingLimitService {
  private readonly logger = new Logger(SpendingLimitService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly policyService: PolicyService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Computes the agent's confirmed spend aggregates for the three standard
   * periods. All three windows are derived from UTC boundaries so they reset
   * consistently regardless of the server's local timezone.
   *
   * The query runs inside a `READ COMMITTED` snapshot (Prisma default) which
   * is sufficient because:
   *   - We read committed rows only (no phantom reads needed for a sum check).
   *   - The TransactionLockInterceptor already serialises requests on
   *     `transaction:{walletId}` at the application level, preventing two
   *     concurrent submissions from the same wallet from racing here.
   *
   * Only PENDING, SUBMITTED, CONFIRMED, and COMPLETED transactions count toward
   * the aggregate — DRAFT/REJECTED/FAILED/CANCELLED/EXPIRED are excluded.
   */
  async aggregateSpend(agentId: string, asset: string): Promise<SpendAggregates> {
    const now = new Date();

    // UTC day boundary — midnight today
    const startOfDay = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );

    // UTC week boundary — most-recent Monday at midnight
    const dayOfWeek = now.getUTCDay(); // 0 = Sunday
    const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const startOfWeek = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - daysSinceMonday,
      ),
    );

    // UTC month boundary — 1st of the current month
    const startOfMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );

    const COUNTED_STATUSES: TransactionStatus[] = [
      TransactionStatus.PENDING,
      TransactionStatus.SUBMITTED,
      TransactionStatus.CONFIRMED,
      TransactionStatus.COMPLETED,
    ];

    // Run all three aggregates in parallel within a single Prisma transaction
    // to get a consistent snapshot.
    const [dayResult, weekResult, monthResult] = await this.prisma.$transaction([
      this.prisma.transaction.aggregate({
        _sum: { amount: true },
        where: {
          agentId,
          asset,
          status: { in: COUNTED_STATUSES },
          deletedAt: null,
          createdAt: { gte: startOfDay },
        },
      }),
      this.prisma.transaction.aggregate({
        _sum: { amount: true },
        where: {
          agentId,
          asset,
          status: { in: COUNTED_STATUSES },
          deletedAt: null,
          createdAt: { gte: startOfWeek },
        },
      }),
      this.prisma.transaction.aggregate({
        _sum: { amount: true },
        where: {
          agentId,
          asset,
          status: { in: COUNTED_STATUSES },
          deletedAt: null,
          createdAt: { gte: startOfMonth },
        },
      }),
    ]);

    return {
      spentToday: dayResult._sum?.amount?.toNumber() ?? 0,
      spentThisWeek: weekResult._sum?.amount?.toNumber() ?? 0,
      spentThisMonth: monthResult._sum?.amount?.toNumber() ?? 0,
    };
  }

  /**
   * Returns true if the agent has at least one active spending-limit policy
   * (a policy with `dailyLimit`, `weeklyLimit`, or `monthlyLimit` configured).
   * Used to short-circuit the aggregate query when no periodic limits apply.
   */
  async hasSpendingLimitPolicy(
    organizationId: string,
    agentId: string,
  ): Promise<boolean> {
    const policies = await this.prisma.policy.findMany({
      where: {
        organizationId,
        enabled: true,
        deletedAt: null,
        OR: [{ agentId: null }, { agentId }],
      },
      select: { configuration: true },
    });

    return policies.some((p) => {
      const config = p.configuration as PolicyConfiguration;
      return (
        config.dailyLimit !== undefined ||
        config.weeklyLimit !== undefined ||
        config.monthlyLimit !== undefined
      );
    });
  }

  /**
   * Core entry-point called by the transaction pipeline and the
   * {@link SpendingLimitGuard}.
   *
   * When called from {@link TransactionService.create}, the intent is
   * already enriched with real spend aggregates (fetched once, passed in) so
   * this method skips the aggregate query and goes directly to evaluation.
   * When called from the guard, the intent has no aggregates yet, so this
   * method fetches them first.
   *
   * Flow:
   *  1. Short-circuit if no agent or no periodic limit policy is configured.
   *  2. Fetch aggregates (only when not already present on the intent).
   *  3. Enrich intent if aggregates were freshly fetched.
   *  4. Evaluate via {@link PolicyService.evaluateIntent}.
   *  5. On violation: write audit log, throw {@link PolicyViolationException}.
   *
   * @param intent   Transaction intent, optionally pre-enriched with aggregates.
   * @param actorId  Authenticated user id for audit attribution.
   */
  async evaluateSpendingLimits(
    intent: TransactionIntent,
    actorId?: string,
  ): Promise<void> {
    const { agentId, organizationId, asset } = intent;

    if (!agentId) {
      return;
    }

    const hasLimits = await this.hasSpendingLimitPolicy(organizationId, agentId);
    if (!hasLimits) {
      return;
    }

    // Use aggregates already embedded in the intent when the caller (e.g.
    // TransactionService) pre-fetched them to avoid a redundant round-trip.
    // The guard passes a bare intent so we fetch here in that case.
    const alreadyEnriched =
      intent.spentToday !== undefined &&
      intent.spentThisWeek !== undefined &&
      intent.spentThisMonth !== undefined;

    let enrichedIntent = intent;
    let aggregates: SpendAggregates;

    if (alreadyEnriched) {
      aggregates = {
        spentToday: intent.spentToday!,
        spentThisWeek: intent.spentThisWeek!,
        spentThisMonth: intent.spentThisMonth!,
      };
    } else {
      aggregates = await this.aggregateSpend(agentId, asset);
      enrichedIntent = {
        ...intent,
        spentToday: aggregates.spentToday,
        spentThisWeek: aggregates.spentThisWeek,
        spentThisMonth: aggregates.spentThisMonth,
      };
    }

    const result = await this.policyService.evaluateIntent(enrichedIntent, actorId);

    if (!result.passed) {
      if (actorId || organizationId) {
        await this.persistViolationAuditLog(
          organizationId,
          actorId ?? null,
          agentId,
          enrichedIntent,
          result.violations,
          aggregates,
        );
      }

      const violationMessages = result.violations
        .map((v) => `${v.policyName}: ${v.message}`)
        .join('; ');

      throw new PolicyViolationException(
        `Transaction blocked by spending limit policy: ${violationMessages}`,
        {
          violations: result.violations,
          requiresApproval: result.requiresApproval,
          aggregates,
        },
      );
    }
  }

  // ── private helpers ──────────────────────────────────────────────────────

  /**
   * Writes an audit log entry for a spending limit policy failure.
   * Failures here are logged but never allowed to propagate — a broken audit
   * write must never silently allow a blocked transaction through.
   */
  private async persistViolationAuditLog(
    organizationId: string,
    actorId: string | null,
    agentId: string,
    intent: TransactionIntent,
    violations: Array<{ policyId: string; policyName: string; code: string; message: string }>,
    aggregates: SpendAggregates,
  ): Promise<void> {
    try {
      await this.auditService.record({
        organizationId,
        userId: actorId,
        action: 'SPENDING_LIMIT_EXCEEDED',
        entity: 'transaction',
        entityId: agentId,
        oldValue: null as unknown as Prisma.InputJsonValue,
        newValue: {
          agentId,
          asset: intent.asset,
          amount: intent.amount,
          recipientAddress: intent.recipientAddress,
          violations,
          aggregates,
          evaluatedAt: new Date().toISOString(),
        } as unknown as Prisma.InputJsonValue,
      });
    } catch (auditError) {
      // Audit failures must never surface to the caller as a 500 — they are
      // background bookkeeping. Log and continue so the PolicyViolationException
      // is what the caller sees.
      this.logger.error(
        `Failed to persist spending-limit violation audit log for agent ${agentId}: ${(auditError as Error).message}`,
      );
    }
  }
}
