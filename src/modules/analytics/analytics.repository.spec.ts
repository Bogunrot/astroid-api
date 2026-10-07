import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../database/prisma.service';
import { AnalyticsRepository } from './analytics.repository';

describe('AnalyticsRepository', () => {
  it('orders agent contribution aggregates by total spend in the database', async () => {
    const groupBy = vi.fn().mockResolvedValue([]);
    const repository = new AnalyticsRepository({
      transaction: { groupBy },
    } as unknown as PrismaService);

    await repository.spendByAgent('org-1');

    expect(groupBy).toHaveBeenCalledWith({
      by: ['agentId'],
      where: {
        organizationId: 'org-1',
        status: 'COMPLETED',
        deletedAt: null,
        agentId: { not: null },
      },
      _sum: { amount: true },
      _count: { _all: true },
      orderBy: { _sum: { amount: 'desc' } },
    });
  });
});
