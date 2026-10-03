import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnalyticsService } from './analytics.service';
import { AnalyticsRepository } from './analytics.repository';

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let repository: { overview: ReturnType<typeof vi.fn>; spendByAgent: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    repository = {
      overview: vi.fn(),
      spendByAgent: vi.fn(),
    };
    service = new AnalyticsService(repository as unknown as AnalyticsRepository);
  });

  describe('overview', () => {
    it('fetches every card in a single batched repository call', async () => {
      repository.overview.mockResolvedValue({
        agents: 3,
        wallets: 2,
        pendingProposals: 1,
        allTime: { _sum: { amount: 100 }, _count: { _all: 10 }, _avg: { riskScore: 42 } },
        last30d: { _sum: { amount: 50 }, _count: { _all: 5 }, _avg: { riskScore: 20 } },
        byStatus: [{ status: 'COMPLETED', _count: { _all: 8 } }],
        byRisk: [{ riskBand: 'LOW', _count: { _all: 6 } }],
      });

      const result = await service.overview('org-1');

      expect(repository.overview).toHaveBeenCalledTimes(1);
      expect(repository.overview).toHaveBeenCalledWith('org-1', expect.any(Date));
      expect(result.counts).toEqual({
        agents: 3,
        wallets: 2,
        pendingProposals: 1,
        transactions: 10,
      });
      expect(result.spend.allTime).toBe('100');
      expect(result.spend.last30Days).toBe('50');
      expect(result.spend.averageRiskScore).toBe(42);
      expect(result.transactionsByStatus).toEqual([{ status: 'COMPLETED', count: 8 }]);
      expect(result.transactionsByRiskBand).toEqual([{ riskBand: 'LOW', count: 6 }]);
    });

    it('defaults spend to zero when there is no transaction history', async () => {
      repository.overview.mockResolvedValue({
        agents: 0,
        wallets: 0,
        pendingProposals: 0,
        allTime: { _sum: { amount: null }, _count: { _all: 0 }, _avg: { riskScore: null } },
        last30d: { _sum: { amount: null }, _count: { _all: 0 }, _avg: { riskScore: null } },
        byStatus: [],
        byRisk: [],
      });

      const result = await service.overview('org-empty');

      expect(result.spend.allTime).toBe('0');
      expect(result.spend.last30Days).toBe('0');
      expect(result.spend.averageRiskScore).toBe(0);
    });
  });

  describe('spendByAgent', () => {
    it('maps repository rows to the response shape, preserving repository order', async () => {
      repository.spendByAgent.mockResolvedValue([
        { agentId: 'a2', _sum: { amount: 100 }, _count: { _all: 2 } },
        { agentId: 'a1', _sum: { amount: 10 }, _count: { _all: 1 } },
      ]);

      const result = await service.spendByAgent('org-1');

      expect(result).toEqual([
        { agentId: 'a2', totalSpent: '100', transactionCount: 2 },
        { agentId: 'a1', totalSpent: '10', transactionCount: 1 },
      ]);
    });
  });
});
