import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditWorker } from './audit.worker';
import { AuditJobData } from '../queues/queues.constants';
import { AuditHashService } from '../modules/audit/audit-hash.service';

type CreateArgs = {
  organizationId: string;
  action: string;
  entity: string;
  entityId?: string | null;
  userId?: string | null;
  requestId?: string | null;
  previousHash?: string | null;
  hash?: string | null;
};

const createJob = (data: AuditJobData, attemptsMade = 0, attempts = 5) =>
  ({
    id: 'job-1',
    name: 'audit-persist',
    data,
    attemptsMade,
    opts: { attempts },
  }) as never;

describe('AuditWorker', () => {
  let auditLogCreate: ReturnType<typeof vi.fn>;
  let workerClient: { $transaction: ReturnType<typeof vi.fn> };
  let prisma: { workerClient: unknown };
  let hashService: {
    getLatestHash: ReturnType<typeof vi.fn>;
    computeEntryHash: ReturnType<typeof vi.fn>;
  };
  let worker: AuditWorker;

  beforeEach(() => {
    vi.clearAllMocks();

    auditLogCreate = vi.fn().mockResolvedValue({});
    workerClient = {
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<number>) =>
        fn({ auditLog: { create: auditLogCreate } }),
      ),
    };
    prisma = { workerClient };

    hashService = {
      getLatestHash: vi.fn().mockResolvedValue('prev-hash'),
      computeEntryHash: vi
        .fn()
        .mockImplementation((input: { organizationId: string }) => ({
          previousHash: 'prev-hash',
          hash: `hash-of-${input.organizationId}`,
        })),
    };

    worker = new AuditWorker(
      prisma as never,
      hashService as unknown as AuditHashService,
    );
  });

  it('persists a batch of entries in a single transaction', async () => {
    const data: AuditJobData = {
      entries: [
        {
          organizationId: 'org-1',
          action: 'POLICY_CHECK',
          entity: 'Policy',
          entityId: 'pol-1',
        },
        {
          organizationId: 'org-1',
          action: 'AUTH_ATTEMPT',
          entity: 'User',
          entityId: 'user-1',
        },
        {
          organizationId: 'org-1',
          action: 'RISK_EVALUATED',
          entity: 'Transaction',
          entityId: 'txn-1',
        },
      ],
    };

    const result = await worker.process(createJob(data));

    expect(workerClient.$transaction).toHaveBeenCalledOnce();
    expect(auditLogCreate).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ persisted: 3 });
  });

  it('chains each entry to the previous hash within the batch', async () => {
    const data: AuditJobData = {
      entries: [
        { organizationId: 'org-1', action: 'A', entity: 'E1' },
        { organizationId: 'org-1', action: 'B', entity: 'E2' },
      ],
    };

    await worker.process(createJob(data));

    const firstCall = auditLogCreate.mock.calls[0][0] as { data: CreateArgs };
    const secondCall = auditLogCreate.mock.calls[1][0] as { data: CreateArgs };

    expect(firstCall.data.previousHash).toBe('prev-hash');
    expect(secondCall.data.previousHash).toBe('hash-of-org-1');
  });

  it('records null hash fields when the hash service is unavailable', async () => {
    const fallbackWorker = new AuditWorker(prisma as never);
    const data: AuditJobData = {
      entries: [{ organizationId: 'org-1', action: 'A', entity: 'E1' }],
    };

    await fallbackWorker.process(createJob(data));

    const call = auditLogCreate.mock.calls[0][0] as { data: CreateArgs };
    expect(call.data.previousHash).toBeNull();
    expect(call.data.hash).toBeNull();
  });

  it('normalizes optional fields to null on insert', async () => {
    const data: AuditJobData = {
      entries: [{ organizationId: 'org-1', action: 'A', entity: 'E1' }],
    };

    await worker.process(createJob(data));

    const call = auditLogCreate.mock.calls[0][0] as { data: CreateArgs };
    expect(call.data.userId).toBeNull();
    expect(call.data.requestId).toBeNull();
  });

  it('returns zero persisted without touching the database for an empty batch', async () => {
    const result = await worker.process(createJob({ entries: [] }));

    expect(result).toEqual({ persisted: 0 });
    expect(workerClient.$transaction).not.toHaveBeenCalled();
  });

  it('rethrows persistence failures so BullMQ retries with backoff', async () => {
    workerClient.$transaction.mockRejectedValue(new Error('Connection terminated'));

    await expect(
      worker.process(
        createJob({ entries: [{ organizationId: 'org-1', action: 'A', entity: 'E1' }] }),
      ),
    ).rejects.toThrow('Connection terminated');
  });

  it('survives (does not crash) when the database write fails on the final attempt', async () => {
    workerClient.$transaction.mockRejectedValue(new Error('write failure'));

    // Final attempt: attemptsMade is the last of 5 attempts. The error still
    // propagates to BullMQ, but process() itself must not throw anything other
    // than the original error (no unhandled crash / process exit).
    const promise = worker.process(
      createJob({ entries: [{ organizationId: 'org-1', action: 'A', entity: 'E1' }] }, 4, 5),
    );
    await expect(promise).rejects.toThrow('write failure');
  });

  it('uses the direct prisma client when no dedicated worker client exists', async () => {
    const plainPrisma = {
      workerClient: undefined,
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<number>) =>
        fn({ auditLog: { create: auditLogCreate } }),
      ),
    };
    const fallbackWorker = new AuditWorker(plainPrisma as never);

    await fallbackWorker.process(
      createJob({ entries: [{ organizationId: 'org-1', action: 'A', entity: 'E1' }] }),
    );

    expect(plainPrisma.$transaction).toHaveBeenCalledOnce();
  });
});
