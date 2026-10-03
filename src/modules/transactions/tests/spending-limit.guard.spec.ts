import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ExecutionContext } from '@nestjs/common';
import { SpendingLimitGuard, SPENDING_LIMIT_GUARD_KEY } from '../guards/spending-limit.guard';
import { SpendingLimitService } from '../spending-limit.service';
import { PolicyViolationException } from '../../../common/exceptions/domain.exception';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_STELLAR = 'GDEGSXLGANKHK7QFOV63XCBHBTZ3YRKUJV7ZB7JMSJQB5CNBRLL5QIG5';

function makeContext(overrides: {
  body?: Record<string, unknown>;
  user?: Record<string, unknown> | null;
  reflectorEnabled?: boolean;
}): ExecutionContext {
  const { body = {}, user = { id: 'user-1', organizationId: 'org-1' }, reflectorEnabled = true } = overrides;

  const mockRequest = { body, user };

  return {
    switchToHttp: () => ({
      getRequest: () => mockRequest,
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
    // Provide a reflector-compatible API via the context for our mock Reflector
    _reflectorEnabled: reflectorEnabled,
  } as unknown as ExecutionContext;
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSpendingLimitService = {
  evaluateSpendingLimits: vi.fn(),
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('SpendingLimitGuard', () => {
  let guard: SpendingLimitGuard;
  let reflector: Reflector;

  beforeEach(async () => {
    vi.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SpendingLimitGuard,
        Reflector,
        { provide: SpendingLimitService, useValue: mockSpendingLimitService },
      ],
    }).compile();

    guard = module.get<SpendingLimitGuard>(SpendingLimitGuard);
    reflector = module.get<Reflector>(Reflector);
  });

  // ── decorator opt-in ──────────────────────────────────────────────────────

  describe('when decorator is NOT present', () => {
    it('returns true without calling SpendingLimitService', async () => {
      vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);

      const ctx = makeContext({ body: { agentId: 'agent-1', amount: '100', asset: 'USDC', recipientAddress: VALID_STELLAR, walletId: 'wallet-1' } });
      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      expect(mockSpendingLimitService.evaluateSpendingLimits).not.toHaveBeenCalled();
    });
  });

  // ── no agentId ────────────────────────────────────────────────────────────

  describe('when decorator is present but no agentId in body', () => {
    it('returns true without calling SpendingLimitService (org-level transaction)', async () => {
      vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);

      const ctx = makeContext({
        body: { amount: '100', asset: 'USDC', recipientAddress: VALID_STELLAR, walletId: 'wallet-1' },
      });
      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      expect(mockSpendingLimitService.evaluateSpendingLimits).not.toHaveBeenCalled();
    });
  });

  // ── no organizationId (unauthenticated / @Public route) ──────────────────

  describe('when no organizationId on request.user', () => {
    it('returns true without evaluating limits', async () => {
      vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);

      const ctx = makeContext({
        body: { agentId: 'agent-1', amount: '100', asset: 'USDC', recipientAddress: VALID_STELLAR },
        user: { id: 'user-1' }, // no organizationId
      });
      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      expect(mockSpendingLimitService.evaluateSpendingLimits).not.toHaveBeenCalled();
    });
  });

  // ── successful evaluation (limits not exceeded) ───────────────────────────

  describe('when evaluation passes', () => {
    beforeEach(() => {
      vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
      mockSpendingLimitService.evaluateSpendingLimits.mockResolvedValue(undefined);
    });

    it('returns true and calls SpendingLimitService with the correct intent', async () => {
      const ctx = makeContext({
        body: {
          agentId: 'agent-1',
          amount: '250',
          asset: 'USDC',
          recipientAddress: VALID_STELLAR,
          walletId: 'wallet-1',
        },
      });

      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      expect(mockSpendingLimitService.evaluateSpendingLimits).toHaveBeenCalledTimes(1);

      const [intent, actorId] = mockSpendingLimitService.evaluateSpendingLimits.mock.calls[0] as [Record<string, unknown>, string];
      expect(intent.organizationId).toBe('org-1');
      expect(intent.agentId).toBe('agent-1');
      expect(intent.amount).toBe(250);
      expect(intent.asset).toBe('USDC');
      expect(intent.recipientAddress).toBe(VALID_STELLAR);
      expect(intent.walletId).toBe('wallet-1');
      expect(actorId).toBe('user-1');
    });

    it('uses XLM as default asset when none provided', async () => {
      const ctx = makeContext({
        body: { agentId: 'agent-1', amount: '50', recipientAddress: VALID_STELLAR },
      });

      await guard.canActivate(ctx);

      const [intent] = mockSpendingLimitService.evaluateSpendingLimits.mock.calls[0] as [Record<string, unknown>];
      expect(intent.asset).toBe('XLM');
    });

    it('passes amount as a number (not a string)', async () => {
      const ctx = makeContext({
        body: {
          agentId: 'agent-1',
          amount: '750.5000000',
          asset: 'XLM',
          recipientAddress: VALID_STELLAR,
        },
      });

      await guard.canActivate(ctx);

      const [intent] = mockSpendingLimitService.evaluateSpendingLimits.mock.calls[0] as [Record<string, unknown>];
      expect(typeof intent.amount).toBe('number');
      expect(intent.amount).toBe(750.5);
    });
  });

  // ── violation — daily limit exceeded ─────────────────────────────────────

  describe('when evaluation fails (limit exceeded)', () => {
    beforeEach(() => {
      vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    });

    it('propagates PolicyViolationException thrown by SpendingLimitService', async () => {
      mockSpendingLimitService.evaluateSpendingLimits.mockRejectedValue(
        new PolicyViolationException(
          'Transaction blocked by spending limit policy: Daily Spend Cap: Projected daily spend 550 exceeds limit 500',
          {
            violations: [
              { policyId: 'p-1', policyName: 'Daily Spend Cap', code: 'DAILY_LIMIT_EXCEEDED', message: 'Projected daily spend 550 exceeds limit 500' },
            ],
            aggregates: { spentToday: 450, spentThisWeek: 450, spentThisMonth: 450 },
          },
        ),
      );

      const ctx = makeContext({
        body: { agentId: 'agent-1', amount: '100', asset: 'USDC', recipientAddress: VALID_STELLAR, walletId: 'wallet-1' },
      });

      await expect(guard.canActivate(ctx)).rejects.toThrow(PolicyViolationException);
    });

    it('propagates the correct error code (POLICY_VIOLATION)', async () => {
      const violation = new PolicyViolationException('Limit exceeded', {});
      mockSpendingLimitService.evaluateSpendingLimits.mockRejectedValue(violation);

      const ctx = makeContext({
        body: { agentId: 'agent-1', amount: '100', asset: 'USDC', recipientAddress: VALID_STELLAR },
      });

      let caught: PolicyViolationException | undefined;
      try {
        await guard.canActivate(ctx);
      } catch (err) {
        caught = err as PolicyViolationException;
      }

      expect(caught).toBeInstanceOf(PolicyViolationException);
      expect(caught?.code).toBe('POLICY_VIOLATION');
      expect(caught?.getStatus()).toBe(422);
    });

    it('does not swallow other unexpected errors from the service', async () => {
      mockSpendingLimitService.evaluateSpendingLimits.mockRejectedValue(
        new Error('Prisma connection lost'),
      );

      const ctx = makeContext({
        body: { agentId: 'agent-1', amount: '100', asset: 'USDC', recipientAddress: VALID_STELLAR },
      });

      await expect(guard.canActivate(ctx)).rejects.toThrow('Prisma connection lost');
    });
  });

  // ── reflector metadata key ────────────────────────────────────────────────

  describe('metadata key contract', () => {
    it('reads the correct metadata key from the reflector', async () => {
      const getAllAndOverrideSpy = vi
        .spyOn(reflector, 'getAllAndOverride')
        .mockReturnValue(false);

      const ctx = makeContext({ body: { agentId: 'agent-1' } });
      await guard.canActivate(ctx);

      expect(getAllAndOverrideSpy).toHaveBeenCalledWith(SPENDING_LIMIT_GUARD_KEY, expect.any(Array));
    });
  });
});
