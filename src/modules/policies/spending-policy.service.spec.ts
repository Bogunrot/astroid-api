import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { PolicyType } from '@prisma/client';

import {
  NotFoundException,
  ValidationException,
  VelocityLimitExceededException,
} from '../../common/exceptions/domain.exception';
import { PaginationQuery } from '../../common/helpers/pagination';
import { SpendingPolicyRepository } from './spending-policy.repository';
import { SpendingPolicyService } from './spending-policy.service';
import { CreatePolicyInput, UpdatePolicyInput } from './policy.dto';

type MockRepository = {
  create: ReturnType<typeof vi.fn>;
  findById: ReturnType<typeof vi.fn>;
  findActiveForEvaluation: ReturnType<typeof vi.fn>;
  findActiveForEvaluationByAgent: ReturnType<typeof vi.fn>;
  findManyAndCount: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  softDelete: ReturnType<typeof vi.fn>;
  sumSpentInWindow: ReturnType<typeof vi.fn>;
  recordEvaluationAudit: ReturnType<typeof vi.fn>;
};

function makeRepository(): MockRepository {
  return {
    create: vi.fn().mockResolvedValue({ id: 'policy-1' }),
    findById: vi.fn().mockResolvedValue({ id: 'policy-1' }),
    findActiveForEvaluation: vi.fn().mockResolvedValue([]),
    findActiveForEvaluationByAgent: vi.fn().mockResolvedValue([]),
    findManyAndCount: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    update: vi.fn().mockResolvedValue({ id: 'policy-1' }),
    softDelete: vi.fn().mockResolvedValue({ id: 'policy-1' }),
    sumSpentInWindow: vi.fn().mockResolvedValue(0),
    recordEvaluationAudit: vi.fn().mockResolvedValue({ id: 'audit-1' }),
  };
}

const CREATE_INPUT: CreatePolicyInput = {
  name: 'Daily limit',
  type: PolicyType.MAX_AMOUNT,
  configuration: { dailyLimit: 100 },
  priority: 100,
  enabled: true,
};

/** A policy row shape good enough for the daily-limit lookup. */
function policyRow(configuration: Record<string, unknown>) {
  return { id: 'policy-1', configuration };
}

describe('SpendingPolicyService', () => {
  let repository: MockRepository;
  let service: SpendingPolicyService;

  beforeEach(() => {
    repository = makeRepository();
    service = new SpendingPolicyService(repository as unknown as SpendingPolicyRepository);
  });

  describe('create', () => {
    it('validates the configuration and connects the organization and agent', async () => {
      await service.create('org-1', { ...CREATE_INPUT, agentId: 'agent-1' });

      expect(repository.create).toHaveBeenCalledWith({
        organization: { connect: { id: 'org-1' } },
        agent: { connect: { id: 'agent-1' } },
        name: 'Daily limit',
        description: undefined,
        type: PolicyType.MAX_AMOUNT,
        configuration: { dailyLimit: 100 },
        priority: 100,
        enabled: true,
      });
    });

    it('omits the agent connection when no agent is targeted', async () => {
      await service.create('org-1', CREATE_INPUT);

      const data = repository.create.mock.calls[0][0];
      expect(data).not.toHaveProperty('agent');
    });

    it('rejects an invalid spending configuration before touching the database', async () => {
      await expect(
        service.create('org-1', {
          ...CREATE_INPUT,
          configuration: { dailyLimit: -1 } as CreatePolicyInput['configuration'],
        }),
      ).rejects.toBeInstanceOf(ValidationException);

      expect(repository.create).not.toHaveBeenCalled();
    });
  });

  describe('list and retrieval', () => {
    it('returns a paginated result built from the repository transaction', async () => {
      repository.findManyAndCount.mockResolvedValue({ items: [{ id: 'policy-1' }], total: 1 });

      const result = await service.list('org-1', {
        page: 1,
        limit: 20,
        search: 'limit',
      } as PaginationQuery);

      expect(repository.findManyAndCount).toHaveBeenCalledWith(
        { organizationId: 'org-1', deletedAt: null, name: { contains: 'limit', mode: 'insensitive' } },
        expect.objectContaining({ take: 20 }),
      );
      expect(result.items).toEqual([{ id: 'policy-1' }]);
      expect(result.meta.total).toBe(1);
    });

    it('throws NotFound when the policy does not belong to the organization', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.getOrThrow('org-1', 'policy-9')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('update and remove', () => {
    it('validates the configuration only when one is supplied', async () => {
      const input: UpdatePolicyInput = { configuration: { dailyLimit: 250 } };

      await service.update('org-1', 'policy-1', input);

      expect(repository.update).toHaveBeenCalledWith('policy-1', {
        name: undefined,
        description: undefined,
        type: undefined,
        priority: undefined,
        enabled: undefined,
        configuration: { dailyLimit: 250 },
      });
    });

    it('refuses to update a policy outside the organization', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(
        service.update('org-1', 'policy-9', { name: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('soft-deletes after verifying ownership', async () => {
      await expect(service.remove('org-1', 'policy-1')).resolves.toEqual({
        id: 'policy-1',
        deleted: true,
      });
      expect(repository.softDelete).toHaveBeenCalledWith('policy-1');
    });
  });

  describe('velocity limit', () => {
    it('rejects spend that would exceed the rolling daily limit', async () => {
      repository.findActiveForEvaluationByAgent.mockResolvedValue([policyRow({ dailyLimit: 100 })]);
      repository.sumSpentInWindow.mockResolvedValue(80);

      await expect(service.checkVelocityLimit('agent-1', 30, 'USDC')).rejects.toBeInstanceOf(
        VelocityLimitExceededException,
      );

      expect(repository.sumSpentInWindow).toHaveBeenCalledWith({
        agentId: 'agent-1',
        assetCode: 'USDC',
        since: expect.any(Date),
      });
    });

    it('allows spend that stays within the limit', async () => {
      repository.findActiveForEvaluationByAgent.mockResolvedValue([policyRow({ dailyLimit: 100 })]);
      repository.sumSpentInWindow.mockResolvedValue(10);

      await expect(service.checkVelocityLimit('agent-1', 20, 'USDC')).resolves.toBeUndefined();
    });

    it('is a no-op for agents without a daily-limit policy and never sums history', async () => {
      repository.findActiveForEvaluationByAgent.mockResolvedValue([policyRow({ maxAmount: 50 })]);

      await expect(service.checkVelocityLimit('agent-1', 1_000, 'USDC')).resolves.toBeUndefined();
      expect(repository.sumSpentInWindow).not.toHaveBeenCalled();
    });
  });

  describe('evaluation audit', () => {
    const intent = {
      organizationId: 'org-1',
      agentId: 'agent-1',
      asset: 'USDC',
      amount: 10,
      recipientAddress: 'GABC',
    };
    const result = {
      passed: false,
      requiresApproval: false,
      violations: [],
      evaluatedPolicyIds: ['policy-1'],
      matchedPolicyId: 'policy-1',
    };

    it('appends the evaluation outcome to the audit trail', async () => {
      await service.recordEvaluationAudit(intent, result, 'user-1');

      expect(repository.recordEvaluationAudit).toHaveBeenCalledWith({
        organizationId: 'org-1',
        userId: 'user-1',
        policyId: 'policy-1',
        payload: expect.objectContaining({ passed: false, transactionIntent: intent }),
      });
    });

    it('swallows repository failures so the payment pipeline is never blocked', async () => {
      const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      repository.recordEvaluationAudit.mockRejectedValue(new Error('audit table down'));

      await expect(
        service.recordEvaluationAudit(intent, result, 'user-1'),
      ).resolves.toBeUndefined();
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining('Failed to persist policy evaluation audit log'),
      );
      logger.mockRestore();
    });
  });
});
