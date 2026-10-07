import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { SpendingLimitService } from '../spending-limit.service';
import { PolicyService } from '../../policies/policy.service';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../../database/prisma.service';
import { PolicyViolationException } from '../../../common/exceptions/domain.exception';
import { TransactionIntent } from '../../policies/policy.types';
import { Decimal } from '@prisma/client/runtime/library';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_STELLAR = 'GDEGSXLGANKHK7QFOV63XCBHBTZ3YRKUJV7ZB7JMSJQB5CNBRLL5QIG5';

function makeIntent(overrides: Partial<TransactionIntent> = {}): TransactionIntent {
  return {
    organizationId: 'org-1',
    agentId: 'agent-1',
    walletId: 'wallet-1',
    asset: 'USDC',
    amount: 100,
    recipientAddress: VALID_STELLAR,
    at: new Date('2026-09-30T10:00:00Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPolicyService = {
  evaluateIntent: vi.fn(),
};

const mockAuditService = {
  record: vi.fn(),
};

// Prisma mock — returns Decimal sums for the three aggregate windows
const makeDecimal = (n: number) => ({ toNumber: () => n } as unknown as Decimal);

const mockPrismaService = {
  $transaction: vi.fn(),
  policy: {
    findMany: vi.fn(),
  },
  transaction: {
    aggregate: vi.fn(),
  },
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('SpendingLimitService', () => {
  let service: SpendingLimitService;

  beforeEach(async () => {
    vi.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SpendingLimitService,
        { provide: PolicyService, useValue: mockPolicyService },
        { provide: AuditService, useValue: mockAuditService },
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<SpendingLimitService>(SpendingLimitService);
  });

  // ── aggregateSpend ────────────────────────────────────────────────────────

  describe('aggregateSpend', () => {
    it('returns zeros when no transactions exist for the agent', async () => {
      mockPrismaService.$transaction.mockResolvedValue([
        { _sum: { amount: null } },
        { _sum: { amount: null } },
        { _sum: { amount: null } },
      ]);

      const result = await service.aggregateSpend('agent-1', 'USDC');

      expect(result).toEqual({ spentToday: 0, spentThisWeek: 0, spentThisMonth: 0 });
    });

    it('converts Prisma Decimal sums to numbers correctly', async () => {
      mockPrismaService.$transaction.mockResolvedValue([
        { _sum: { amount: makeDecimal(50) } },
        { _sum: { amount: makeDecimal(200) } },
        { _sum: { amount: makeDecimal(800) } },
      ]);

      const result = await service.aggregateSpend('agent-1', 'USDC');

      expect(result).toEqual({ spentToday: 50, spentThisWeek: 200, spentThisMonth: 800 });
    });

    it('runs all three aggregate queries in a single prisma $transaction call', async () => {
      mockPrismaService.$transaction.mockResolvedValue([
        { _sum: { amount: null } },
        { _sum: { amount: null } },
        { _sum: { amount: null } },
      ]);

      await service.aggregateSpend('agent-1', 'XLM');

      expect(mockPrismaService.$transaction).toHaveBeenCalledTimes(1);
      // The array passed to $transaction should contain 3 query promises
      const queryArray = mockPrismaService.$transaction.mock.calls[0][0] as unknown[];
      expect(queryArray).toHaveLength(3);
    });
  });

  // ── hasSpendingLimitPolicy ────────────────────────────────────────────────

  describe('hasSpendingLimitPolicy', () => {
    it('returns true when a policy with dailyLimit exists', async () => {
      mockPrismaService.policy.findMany.mockResolvedValue([
        { configuration: { dailyLimit: 500 } },
      ]);

      const result = await service.hasSpendingLimitPolicy('org-1', 'agent-1');
      expect(result).toBe(true);
    });

    it('returns true when a policy with weeklyLimit exists', async () => {
      mockPrismaService.policy.findMany.mockResolvedValue([
        { configuration: { weeklyLimit: 2000 } },
      ]);

      const result = await service.hasSpendingLimitPolicy('org-1', 'agent-1');
      expect(result).toBe(true);
    });

    it('returns true when a policy with monthlyLimit exists', async () => {
      mockPrismaService.policy.findMany.mockResolvedValue([
        { configuration: { monthlyLimit: 10000 } },
      ]);

      const result = await service.hasSpendingLimitPolicy('org-1', 'agent-1');
      expect(result).toBe(true);
    });

    it('returns false when no policies define periodic limits', async () => {
      mockPrismaService.policy.findMany.mockResolvedValue([
        { configuration: { maxAmount: 1000, allowedAssets: ['USDC'] } },
      ]);

      const result = await service.hasSpendingLimitPolicy('org-1', 'agent-1');
      expect(result).toBe(false);
    });

    it('returns false when no policies exist at all', async () => {
      mockPrismaService.policy.findMany.mockResolvedValue([]);

      const result = await service.hasSpendingLimitPolicy('org-1', 'agent-1');
      expect(result).toBe(false);
    });
  });

  // ── evaluateSpendingLimits ────────────────────────────────────────────────

  describe('evaluateSpendingLimits', () => {
    describe('no-op paths', () => {
      it('returns early (no-op) when intent has no agentId', async () => {
        const intent = makeIntent({ agentId: undefined });

        await service.evaluateSpendingLimits(intent, 'user-1');

        expect(mockPrismaService.policy.findMany).not.toHaveBeenCalled();
        expect(mockPolicyService.evaluateIntent).not.toHaveBeenCalled();
      });

      it('returns early (no-op) when no periodic limit policies are configured', async () => {
        mockPrismaService.policy.findMany.mockResolvedValue([
          { configuration: { maxAmount: 5000 } },
        ]);

        await service.evaluateSpendingLimits(makeIntent(), 'user-1');

        expect(mockPolicyService.evaluateIntent).not.toHaveBeenCalled();
        expect(mockAuditService.record).not.toHaveBeenCalled();
      });
    });

    describe('policy passes', () => {
      beforeEach(() => {
        // Org has a daily limit policy
        mockPrismaService.policy.findMany.mockResolvedValue([
          { configuration: { dailyLimit: 500 } },
        ]);
        // Agent has spent 50 today
        mockPrismaService.$transaction.mockResolvedValue([
          { _sum: { amount: makeDecimal(50) } },
          { _sum: { amount: makeDecimal(50) } },
          { _sum: { amount: makeDecimal(50) } },
        ]);
      });

      it('does not throw when spend + amount is within daily limit', async () => {
        mockPolicyService.evaluateIntent.mockResolvedValue({
          passed: true,
          requiresApproval: false,
          violations: [],
          evaluatedPolicyIds: ['policy-1'],
        });

        // 50 already spent + 100 pending = 150, limit is 500 — should pass
        await expect(
          service.evaluateSpendingLimits(makeIntent({ amount: 100 }), 'user-1'),
        ).resolves.toBeUndefined();

        expect(mockAuditService.record).not.toHaveBeenCalled();
      });

      it('enriches intent with real spend aggregates before calling evaluateIntent', async () => {
        mockPolicyService.evaluateIntent.mockResolvedValue({
          passed: true,
          requiresApproval: false,
          violations: [],
          evaluatedPolicyIds: ['policy-1'],
        });

        await service.evaluateSpendingLimits(makeIntent({ amount: 100 }), 'user-1');

        const intentPassedToEngine = mockPolicyService.evaluateIntent.mock.calls[0][0] as TransactionIntent;
        expect(intentPassedToEngine.spentToday).toBe(50);
        expect(intentPassedToEngine.spentThisWeek).toBe(50);
        expect(intentPassedToEngine.spentThisMonth).toBe(50);
        expect(intentPassedToEngine.amount).toBe(100);
      });
    });

    describe('limit exceeded — daily', () => {
      beforeEach(() => {
        mockPrismaService.policy.findMany.mockResolvedValue([
          { configuration: { dailyLimit: 500 } },
        ]);
        // 450 already spent today
        mockPrismaService.$transaction.mockResolvedValue([
          { _sum: { amount: makeDecimal(450) } },
          { _sum: { amount: makeDecimal(450) } },
          { _sum: { amount: makeDecimal(450) } },
        ]);
      });

      it('throws PolicyViolationException when daily limit would be exceeded', async () => {
        mockPolicyService.evaluateIntent.mockResolvedValue({
          passed: false,
          requiresApproval: false,
          violations: [
            {
              policyId: 'policy-1',
              policyName: 'Daily Spend Cap',
              code: 'DAILY_LIMIT_EXCEEDED',
              message: 'Projected daily spend 550 exceeds limit 500',
            },
          ],
          evaluatedPolicyIds: ['policy-1'],
        });

        // 450 + 100 = 550 > 500
        await expect(
          service.evaluateSpendingLimits(makeIntent({ amount: 100 }), 'user-1'),
        ).rejects.toThrow(PolicyViolationException);
      });

      it('throws with error code POLICY_VIOLATION', async () => {
        mockPolicyService.evaluateIntent.mockResolvedValue({
          passed: false,
          requiresApproval: false,
          violations: [
            {
              policyId: 'policy-1',
              policyName: 'Daily Spend Cap',
              code: 'DAILY_LIMIT_EXCEEDED',
              message: 'Projected daily spend 550 exceeds limit 500',
            },
          ],
          evaluatedPolicyIds: ['policy-1'],
        });

        let caughtError: PolicyViolationException | undefined;
        try {
          await service.evaluateSpendingLimits(makeIntent({ amount: 100 }), 'user-1');
        } catch (err) {
          caughtError = err as PolicyViolationException;
        }

        expect(caughtError).toBeInstanceOf(PolicyViolationException);
        expect(caughtError?.code).toBe('POLICY_VIOLATION');
      });

      it('throws with HTTP status 422 on daily limit violation', async () => {
        mockPolicyService.evaluateIntent.mockResolvedValue({
          passed: false,
          requiresApproval: false,
          violations: [
            {
              policyId: 'policy-1',
              policyName: 'Daily Spend Cap',
              code: 'DAILY_LIMIT_EXCEEDED',
              message: 'Projected daily spend 550 exceeds limit 500',
            },
          ],
          evaluatedPolicyIds: ['policy-1'],
        });

        let caughtError: PolicyViolationException | undefined;
        try {
          await service.evaluateSpendingLimits(makeIntent({ amount: 100 }), 'user-1');
        } catch (err) {
          caughtError = err as PolicyViolationException;
        }

        expect(caughtError?.getStatus()).toBe(422);
      });

      it('writes a SPENDING_LIMIT_EXCEEDED audit log entry on violation', async () => {
        mockPolicyService.evaluateIntent.mockResolvedValue({
          passed: false,
          requiresApproval: false,
          violations: [
            {
              policyId: 'policy-1',
              policyName: 'Daily Spend Cap',
              code: 'DAILY_LIMIT_EXCEEDED',
              message: 'Projected daily spend 550 exceeds limit 500',
            },
          ],
          evaluatedPolicyIds: ['policy-1'],
        });
        mockAuditService.record.mockResolvedValue(undefined);

        await expect(
          service.evaluateSpendingLimits(makeIntent({ amount: 100 }), 'user-1'),
        ).rejects.toThrow(PolicyViolationException);

        expect(mockAuditService.record).toHaveBeenCalledTimes(1);
        const auditCall = mockAuditService.record.mock.calls[0][0] as Record<string, unknown>;
        expect(auditCall.action).toBe('SPENDING_LIMIT_EXCEEDED');
        expect(auditCall.entity).toBe('transaction');
        expect(auditCall.userId).toBe('user-1');
        expect(auditCall.organizationId).toBe('org-1');
      });

      it('includes violation codes in the audit log newValue', async () => {
        mockPolicyService.evaluateIntent.mockResolvedValue({
          passed: false,
          requiresApproval: false,
          violations: [
            {
              policyId: 'policy-1',
              policyName: 'Daily Spend Cap',
              code: 'DAILY_LIMIT_EXCEEDED',
              message: 'Projected daily spend 550 exceeds limit 500',
            },
          ],
          evaluatedPolicyIds: ['policy-1'],
        });
        mockAuditService.record.mockResolvedValue(undefined);

        await expect(
          service.evaluateSpendingLimits(makeIntent({ amount: 100 }), 'user-1'),
        ).rejects.toThrow(PolicyViolationException);

        const auditCall = mockAuditService.record.mock.calls[0][0] as Record<string, unknown>;
        const newValue = auditCall.newValue as Record<string, unknown>;
        expect((newValue.violations as Array<{ code: string }>)[0].code).toBe('DAILY_LIMIT_EXCEEDED');
        expect((newValue.aggregates as Record<string, number>).spentToday).toBe(450);
      });

      it('still throws PolicyViolationException even when audit log write fails', async () => {
        mockPolicyService.evaluateIntent.mockResolvedValue({
          passed: false,
          requiresApproval: false,
          violations: [
            {
              policyId: 'policy-1',
              policyName: 'Daily Spend Cap',
              code: 'DAILY_LIMIT_EXCEEDED',
              message: 'Projected daily spend 550 exceeds limit 500',
            },
          ],
          evaluatedPolicyIds: ['policy-1'],
        });
        // Simulate an audit service failure
        mockAuditService.record.mockRejectedValue(new Error('DB connection lost'));

        // The transaction must still be blocked — audit failures are non-fatal
        await expect(
          service.evaluateSpendingLimits(makeIntent({ amount: 100 }), 'user-1'),
        ).rejects.toThrow(PolicyViolationException);
      });
    });

    describe('limit exceeded — weekly', () => {
      it('throws PolicyViolationException when weekly limit would be exceeded', async () => {
        mockPrismaService.policy.findMany.mockResolvedValue([
          { configuration: { weeklyLimit: 1000 } },
        ]);
        mockPrismaService.$transaction.mockResolvedValue([
          { _sum: { amount: makeDecimal(50) } },
          { _sum: { amount: makeDecimal(950) } },   // 950 this week
          { _sum: { amount: makeDecimal(950) } },
        ]);
        mockPolicyService.evaluateIntent.mockResolvedValue({
          passed: false,
          requiresApproval: false,
          violations: [
            {
              policyId: 'policy-2',
              policyName: 'Weekly Spend Cap',
              code: 'WEEKLY_LIMIT_EXCEEDED',
              message: 'Projected weekly spend 1050 exceeds limit 1000',
            },
          ],
          evaluatedPolicyIds: ['policy-2'],
        });

        // 950 + 100 = 1050 > 1000
        await expect(
          service.evaluateSpendingLimits(makeIntent({ amount: 100 }), 'user-1'),
        ).rejects.toThrow(PolicyViolationException);
      });
    });

    describe('limit exceeded — monthly', () => {
      it('throws PolicyViolationException when monthly limit would be exceeded', async () => {
        mockPrismaService.policy.findMany.mockResolvedValue([
          { configuration: { monthlyLimit: 5000 } },
        ]);
        mockPrismaService.$transaction.mockResolvedValue([
          { _sum: { amount: makeDecimal(100) } },
          { _sum: { amount: makeDecimal(500) } },
          { _sum: { amount: makeDecimal(4950) } },  // 4950 this month
        ]);
        mockPolicyService.evaluateIntent.mockResolvedValue({
          passed: false,
          requiresApproval: false,
          violations: [
            {
              policyId: 'policy-3',
              policyName: 'Monthly Spend Cap',
              code: 'MONTHLY_LIMIT_EXCEEDED',
              message: 'Projected monthly spend 5050 exceeds limit 5000',
            },
          ],
          evaluatedPolicyIds: ['policy-3'],
        });

        // 4950 + 100 = 5050 > 5000
        await expect(
          service.evaluateSpendingLimits(makeIntent({ amount: 100 }), 'user-1'),
        ).rejects.toThrow(PolicyViolationException);
      });
    });

    describe('missing policy scenario', () => {
      it('is a no-op and does not throw when no spending policies are configured', async () => {
        // Returns no policies at all
        mockPrismaService.policy.findMany.mockResolvedValue([]);

        await expect(
          service.evaluateSpendingLimits(makeIntent(), 'user-1'),
        ).resolves.toBeUndefined();

        expect(mockPolicyService.evaluateIntent).not.toHaveBeenCalled();
        expect(mockAuditService.record).not.toHaveBeenCalled();
      });

      it('is a no-op when only non-periodic policies exist (maxAmount, blockedAssets)', async () => {
        mockPrismaService.policy.findMany.mockResolvedValue([
          { configuration: { maxAmount: 1000, blockedAssets: ['BTC'] } },
          { configuration: { allowedRecipients: [VALID_STELLAR] } },
        ]);

        await expect(
          service.evaluateSpendingLimits(makeIntent(), 'user-1'),
        ).resolves.toBeUndefined();

        expect(mockPolicyService.evaluateIntent).not.toHaveBeenCalled();
      });
    });

    describe('intent enrichment', () => {
      it('passes enriched intent (with aggregates) to PolicyService.evaluateIntent', async () => {
        mockPrismaService.policy.findMany.mockResolvedValue([
          { configuration: { dailyLimit: 1000, weeklyLimit: 5000, monthlyLimit: 15000 } },
        ]);
        mockPrismaService.$transaction.mockResolvedValue([
          { _sum: { amount: makeDecimal(200) } },
          { _sum: { amount: makeDecimal(1200) } },
          { _sum: { amount: makeDecimal(3500) } },
        ]);
        mockPolicyService.evaluateIntent.mockResolvedValue({
          passed: true,
          requiresApproval: false,
          violations: [],
          evaluatedPolicyIds: ['policy-1'],
        });

        await service.evaluateSpendingLimits(makeIntent({ amount: 50 }), 'user-1');

        const enrichedIntent = mockPolicyService.evaluateIntent.mock.calls[0][0] as TransactionIntent;
        expect(enrichedIntent.spentToday).toBe(200);
        expect(enrichedIntent.spentThisWeek).toBe(1200);
        expect(enrichedIntent.spentThisMonth).toBe(3500);
        expect(enrichedIntent.amount).toBe(50);
        expect(enrichedIntent.agentId).toBe('agent-1');
        expect(enrichedIntent.organizationId).toBe('org-1');
      });

      it('preserves original intent fields (asset, recipientAddress, walletId)', async () => {
        mockPrismaService.policy.findMany.mockResolvedValue([
          { configuration: { dailyLimit: 1000 } },
        ]);
        mockPrismaService.$transaction.mockResolvedValue([
          { _sum: { amount: makeDecimal(0) } },
          { _sum: { amount: makeDecimal(0) } },
          { _sum: { amount: makeDecimal(0) } },
        ]);
        mockPolicyService.evaluateIntent.mockResolvedValue({
          passed: true,
          requiresApproval: false,
          violations: [],
          evaluatedPolicyIds: ['policy-1'],
        });

        const intent = makeIntent({ asset: 'XLM', walletId: 'wallet-42' });
        await service.evaluateSpendingLimits(intent, 'user-1');

        const passedIntent = mockPolicyService.evaluateIntent.mock.calls[0][0] as TransactionIntent;
        expect(passedIntent.asset).toBe('XLM');
        expect(passedIntent.walletId).toBe('wallet-42');
        expect(passedIntent.recipientAddress).toBe(VALID_STELLAR);
      });
    });
  });
});
