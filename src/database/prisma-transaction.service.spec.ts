import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaTransactionService } from './prisma-transaction.service';

/**
 * Mimics `prisma.$transaction` faithfully enough to assert the contract the
 * service promises: the callback receives a transaction client, a throw rolls
 * the unit of work back, and the original error reaches the caller.
 */
function buildPrisma() {
  const state = { committed: 0, rolledBack: 0 };

  const prisma = {
    $transaction: vi.fn(
      async (
        fn: (tx: unknown) => Promise<unknown>,
        options?: { maxWait?: number; timeout?: number; isolationLevel?: string },
      ) => {
        const tx = { __isTransactionClient: true, options };
        try {
          const result = await fn(tx);
          state.committed += 1;
          return result;
        } catch (error) {
          state.rolledBack += 1;
          throw error;
        }
      },
    ),
  };

  return { prisma, state };
}

describe('PrismaTransactionService', () => {
  let service: PrismaTransactionService;
  let prisma: ReturnType<typeof buildPrisma>['prisma'];
  let state: ReturnType<typeof buildPrisma>['state'];

  beforeEach(() => {
    vi.clearAllMocks();
    const built = buildPrisma();
    prisma = built.prisma;
    state = built.state;
    service = new PrismaTransactionService(prisma as never);
  });

  describe('run', () => {
    it('commits and returns the callback result when no error is thrown', async () => {
      const result = await service.run(async (tx) => {
        expect(tx).toBeDefined();
        return 'provisioned';
      });

      expect(result).toBe('provisioned');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(state.committed).toBe(1);
      expect(state.rolledBack).toBe(0);
    });

    it('hands the callback a dedicated transaction client, not the root client', async () => {
      let received: unknown;
      await service.run(async (tx) => {
        received = tx;
      });

      expect(received).not.toBe(prisma);
      expect((received as { __isTransactionClient?: boolean }).__isTransactionClient).toBe(true);
    });

    it('rolls back and propagates the original error when the callback throws', async () => {
      const boom = new Error('budget allocation failed');

      await expect(
        service.run(async () => {
          throw boom;
        }),
      ).rejects.toBe(boom);

      expect(state.committed).toBe(0);
      expect(state.rolledBack).toBe(1);
    });

    it('rolls back when the callback rejects with a non-Error value', async () => {
      await expect(
        service.run(async () => {
          throw 'string failure';
        }),
      ).rejects.toBe('string failure');

      expect(state.rolledBack).toBe(1);
    });

    it('applies the default pool-wait and transaction timeouts', async () => {
      await service.run(async () => undefined);

      const [, options] = prisma.$transaction.mock.calls[0] as [
        unknown,
        { maxWait: number; timeout: number },
      ];
      expect(options.maxWait).toBe(PrismaTransactionService.DEFAULT_MAX_WAIT_MS);
      expect(options.timeout).toBe(PrismaTransactionService.DEFAULT_TIMEOUT_MS);
    });

    it('forwards caller-supplied timeout, maxWait and isolation level', async () => {
      await service.run(async () => undefined, {
        name: 'wallet.provision',
        maxWait: 1_234,
        timeout: 5_678,
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });

      const [, options] = prisma.$transaction.mock.calls[0] as [
        unknown,
        { maxWait: number; timeout: number; isolationLevel: string },
      ];
      expect(options).toMatchObject({
        maxWait: 1_234,
        timeout: 5_678,
        isolationLevel: 'RepeatableRead',
      });
    });
  });

  describe('runSerializable', () => {
    it('forces SERIALIZABLE isolation', async () => {
      await service.runSerializable(async () => 'ok', { name: 'budget.reserve' });

      const [, options] = prisma.$transaction.mock.calls[0] as [
        unknown,
        { isolationLevel: string },
      ];
      expect(options.isolationLevel).toBe('Serializable');
    });

    it('still rolls back on failure', async () => {
      await expect(
        service.runSerializable(async () => {
          throw new Error('write conflict');
        }),
      ).rejects.toThrow('write conflict');

      expect(state.rolledBack).toBe(1);
    });
  });

  describe('runWithRetry', () => {
    it('returns the first successful attempt without replaying', async () => {
      const fn = vi.fn(async () => 'done');

      const result = await service.runWithRetry(fn, { backoffMs: 0 });

      expect(result).toBe('done');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('replays a serialization conflict (P2034) and succeeds on the retry', async () => {
      const conflict = Object.assign(new Error('Transaction failed due to a write conflict'), {
        code: 'P2034',
      });
      const fn = vi
        .fn<(tx: Prisma.TransactionClient) => Promise<string>>()
        .mockRejectedValueOnce(conflict)
        .mockResolvedValueOnce('committed-after-retry');

      const result = await service.runWithRetry(fn, { backoffMs: 0, attempts: 3 });

      expect(result).toBe('committed-after-retry');
      expect(fn).toHaveBeenCalledTimes(2);
      expect(state.rolledBack).toBe(1);
      expect(state.committed).toBe(1);
    });

    it('rethrows without replaying an error that is not a conflict', async () => {
      const boom = new Error('unique constraint violated');
      const fn = vi.fn(async () => {
        throw boom;
      });

      await expect(service.runWithRetry(fn, { backoffMs: 0 })).rejects.toBe(boom);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('gives up after the configured number of attempts', async () => {
      const conflict = Object.assign(new Error('still conflicting'), { code: 'P2034' });
      const fn = vi.fn(async () => {
        throw conflict;
      });

      await expect(service.runWithRetry(fn, { attempts: 2, backoffMs: 0 })).rejects.toBe(conflict);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('honours attempts: 1 by running exactly once', async () => {
      const fn = vi.fn(async () => 'once');

      await service.runWithRetry(fn, { attempts: 1, backoffMs: 0 });

      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('logging', () => {
    it('emits a structured rolled_back record carrying the transaction name', async () => {
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

      await expect(
        service.run(
          async () => {
            throw new Error('boom');
          },
          { name: 'wallet.provision+initial-budget' },
        ),
      ).rejects.toThrow('boom');

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(String(errorSpy.mock.calls[0][0]));
      expect(payload).toMatchObject({
        transaction: 'wallet.provision+initial-budget',
        status: 'rolled_back',
        attempt: 1,
        error: 'boom',
      });
      expect(typeof payload.durationMs).toBe('number');

      vi.restoreAllMocks();
    });

    it('emits a structured committed record on success', async () => {
      const debugSpy = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await service.run(async () => 'ok', { name: 'wallet.provision' });

      const payload = JSON.parse(String(debugSpy.mock.calls[0][0]));
      expect(payload).toMatchObject({
        transaction: 'wallet.provision',
        status: 'committed',
        attempt: 1,
      });

      vi.restoreAllMocks();
    });
  });
});
