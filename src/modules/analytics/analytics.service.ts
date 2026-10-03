import { Injectable } from '@nestjs/common';
import { AnalyticsRepository } from './analytics.repository';

/**
 * Aggregates the immutable transaction history into the summaries that power the
 * dashboard: totals, spend, status/risk distributions and per-agent spend. All
 * queries are scoped to the caller's organization.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly repository: AnalyticsRepository) {}

  /** High-level overview cards for the dashboard home. */
  async overview(organizationId: string) {
    const since30d = new Date(Date.now() - 30 * 86_400_000);
    const { agents, wallets, pendingProposals, allTime, last30d, byStatus, byRisk } =
      await this.repository.overview(organizationId, since30d);

    return {
      counts: {
        agents,
        wallets,
        pendingProposals,
        transactions: allTime._count._all,
      },
      spend: {
        allTime: (allTime._sum.amount ?? 0).toString(),
        last30Days: (last30d._sum.amount ?? 0).toString(),
        averageRiskScore: Math.round(allTime._avg.riskScore ?? 0),
      },
      transactionsByStatus: byStatus.map((row) => ({
        status: row.status,
        count: row._count._all,
      })),
      transactionsByRiskBand: byRisk.map((row) => ({
        riskBand: row.riskBand,
        count: row._count._all,
      })),
    };
  }

  /** Completed spend grouped by initiating agent. */
  async spendByAgent(organizationId: string) {
    const rows = await this.repository.spendByAgent(organizationId);
    return rows.map((row) => ({
      agentId: row.agentId,
      totalSpent: (row._sum.amount ?? 0).toString(),
      transactionCount: row._count._all,
    }));
  }
}
