import { Injectable } from '@nestjs/common';
import { Prisma, TransactionStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

/** Read-only aggregate queries powering dashboards and reporting. */
@Injectable()
export class AnalyticsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Fetches the dashboard overview's counts and spend aggregates in a single
   * batched roundtrip (was 5 separate queries) via `$transaction([...])`, then
   * fetches the two status/risk-band distributions in parallel. Prisma's
   * `groupBy` return type doesn't infer correctly inside a `$transaction`
   * array, so those two stay outside the batch as concurrent queries.
   */
  async overview(organizationId: string, since30d: Date) {
    const completedWhere: Prisma.TransactionWhereInput = {
      organizationId,
      status: TransactionStatus.COMPLETED,
      deletedAt: null,
    };

    const [[agents, wallets, pendingProposals, allTime, last30d], byStatus, byRisk] =
      await Promise.all([
        this.prisma.$transaction([
          this.prisma.agent.count({ where: { organizationId, deletedAt: null } }),
          this.prisma.wallet.count({ where: { organizationId, deletedAt: null } }),
          this.prisma.proposal.count({ where: { organizationId, status: 'PENDING' } }),
          this.prisma.transaction.aggregate({
            where: completedWhere,
            _sum: { amount: true },
            _count: { _all: true },
            _avg: { riskScore: true },
          }),
          this.prisma.transaction.aggregate({
            where: { ...completedWhere, createdAt: { gte: since30d } },
            _sum: { amount: true },
            _count: { _all: true },
            _avg: { riskScore: true },
          }),
        ]),
        this.prisma.transaction.groupBy({
          by: ['status'],
          where: { organizationId, deletedAt: null },
          orderBy: { status: 'asc' },
          _count: { _all: true },
        }),
        this.prisma.transaction.groupBy({
          by: ['riskBand'],
          where: { organizationId, deletedAt: null },
          orderBy: { riskBand: 'asc' },
          _count: { _all: true },
        }),
      ]);

    return { agents, wallets, pendingProposals, allTime, last30d, byStatus, byRisk };
  }

  spendByAgent(organizationId: string) {
    return this.prisma.transaction.groupBy({
      by: ['agentId'],
      where: {
        organizationId,
        status: TransactionStatus.COMPLETED,
        deletedAt: null,
        agentId: { not: null },
      },
      _sum: { amount: true },
      _count: { _all: true },
      orderBy: { _sum: { amount: 'desc' } },
    });
  }
}
