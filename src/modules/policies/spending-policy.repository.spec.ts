import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { TransactionStatus } from '@prisma/client';

import { PrismaPagination } from '../../common/helpers/pagination';
import { PrismaService } from '../../database/prisma.service';
import {
  SETTLED_TRANSACTION_STATUSES,
  SpendingPolicyRepository,
} from './spending-policy.repository';

type MockPrisma = {
  policy: {
    create: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  transaction: { findMany: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

/** Mocked Prisma client: `$transaction` supports both the array and callback forms. */
function makePrisma(): MockPrisma {
  return {
    policy: {
      create: vi.fn().mockResolvedValue({ id: 'policy-1' }),
      findFirst: vi.fn().mockResolvedValue({ id: 'policy-1' }),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({ id: 'policy-1' }),
      count: vi.fn().mockResolvedValue(0),
    },
    transaction: { findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
    $transaction: vi.fn((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => unknown)({})
        : Promise.all(arg as Array<Promise<unknown>>),
    ),
  };
}

const PAGINATION: PrismaPagination = { skip: 0, take: 20, orderBy: { createdAt: 'desc' } };

describe('SpendingPolicyRepository', () => {
  let prisma: MockPrisma;
  let repository: SpendingPolicyRepository;

  beforeEach(() => {
    prisma = makePrisma();
    repository = new SpendingPolicyRepository(prisma as unknown as PrismaService);
  });

  describe('policy persistence', () => {
    it('creates a policy through the Prisma policy delegate', async () => {
      const data = { name: 'Daily limit', type: 'SPENDING_LIMIT' } as never;

      await repository.create(data);

      expect(prisma.policy.create).toHaveBeenCalledWith({ data });
    });

    it('scopes findById to the organization and excludes soft-deleted rows', async () => {
      await repository.findById('org-1', 'policy-1');

      expect(prisma.policy.findFirst).toHaveBeenCalledWith({
        where: { id: 'policy-1', organizationId: 'org-1', deletedAt: null },
      });
    });

    it('fetches org-wide policies plus agent-specific ones in priority order', async () => {
      await repository.findActiveForEvaluation('org-1', 'agent-1');

      expect(prisma.policy.findMany).toHaveBeenCalledWith({
        where: {
          organizationId: 'org-1',
          enabled: true,
          deletedAt: null,
          OR: [{ agentId: null }, { agentId: 'agent-1' }],
        },
        orderBy: { priority: 'asc' },
      });
    });

    it('omits the agent clause when no agent is supplied', async () => {
      await repository.findActiveForEvaluation('org-1');

      const args = prisma.policy.findMany.mock.calls[0][0];
      expect(args.where.OR).toEqual([{ agentId: null }]);
    });

    it('updates and soft-deletes through the policy delegate', async () => {
      await repository.update('policy-1', { name: 'Renamed' });
      expect(prisma.policy.update).toHaveBeenCalledWith({
        where: { id: 'policy-1' },
        data: { name: 'Renamed' },
      });

      await repository.softDelete('policy-1');
      expect(prisma.policy.update).toHaveBeenLastCalledWith({
        where: { id: 'policy-1' },
        data: { deletedAt: expect.any(Date), enabled: false },
      });
    });

    it('reads the page and the total inside a single transaction', async () => {
      prisma.policy.findMany.mockResolvedValue([{ id: 'policy-1' }]);
      prisma.policy.count.mockResolvedValue(1);

      const result = await repository.findManyAndCount({ organizationId: 'org-1' }, PAGINATION);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ items: [{ id: 'policy-1' }], total: 1 });
    });
  });

  describe('spend aggregation', () => {
    it('sums settled spend as a number, including string-encoded decimals', async () => {
      prisma.transaction.findMany.mockResolvedValue([
        { amount: '12.5' },
        { amount: 7.25 },
        { amount: '0.25' },
      ]);

      const total = await repository.sumSpentInWindow({
        agentId: 'agent-1',
        assetCode: 'USDC',
        since: new Date('2026-01-01T00:00:00Z'),
      });

      expect(total).toBe(20);
      expect(prisma.transaction.findMany).toHaveBeenCalledWith({
        where: {
          agentId: 'agent-1',
          asset: 'USDC',
          status: { in: [...SETTLED_TRANSACTION_STATUSES] },
          createdAt: { gte: new Date('2026-01-01T00:00:00Z') },
        },
        select: { amount: true },
      });
    });

    it('honours an explicit status filter', async () => {
      await repository.sumSpentInWindow({
        agentId: 'agent-1',
        assetCode: 'XLM',
        since: new Date(),
        statuses: [TransactionStatus.PENDING],
      });

      const args = prisma.transaction.findMany.mock.calls[0][0];
      expect(args.where.status).toEqual({ in: [TransactionStatus.PENDING] });
    });
  });

  describe('evaluation audit', () => {
    it('appends a POLICY_EVALUATED row to the audit log', async () => {
      await repository.recordEvaluationAudit({
        organizationId: 'org-1',
        userId: 'user-1',
        policyId: 'policy-1',
        payload: { passed: true },
      });

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          organizationId: 'org-1',
          userId: 'user-1',
          action: 'POLICY_EVALUATED',
          entity: 'policy',
          entityId: 'policy-1',
          newValue: { passed: true },
        }),
      });
    });
  });

  describe('transaction safety', () => {
    it('runs interactive work inside $transaction', async () => {
      const work = vi.fn().mockResolvedValue('ok');

      await expect(repository.withTransaction(work)).resolves.toBe('ok');

      expect(prisma.$transaction).toHaveBeenCalledWith(work);
      expect(work).toHaveBeenCalledTimes(1);
    });
  });

  describe('uniform error handling', () => {
    it('logs the failing operation and rethrows the original error', async () => {
      const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const failure = new Error('connection lost');
      prisma.policy.create.mockRejectedValue(failure);

      await expect(repository.create({} as never)).rejects.toBe(failure);
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining('SpendingPolicyRepository.create failed'),
      );
      logger.mockRestore();
    });
  });
});
