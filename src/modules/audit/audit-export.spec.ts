import { describe, it, expect, vi } from 'vitest';
import { AuditService } from './audit.service';
import { AuditRepository } from './audit.repository';
import { AuditHashService } from './audit-hash.service';
import { streamAuditLogsQuerySchema } from './audit-export.dto';

describe('AuditService - Export Compliance', () => {
  const mockRepository = {
    exportLogs: vi.fn(),
    streamLogs: vi.fn(),
    create: vi.fn(),
    findManyAndCount: vi.fn(),
    findById: vi.fn(),
  };

  const mockHashService = {
    getLatestHash: vi.fn().mockResolvedValue(null),
    computeEntryHash: vi.fn().mockReturnValue({ previousHash: null, hash: 'mock-hash' }),
    verifyChainIntegrity: vi.fn(),
    verifyEntryIntegrity: vi.fn(),
  };

  const auditService = new AuditService(
    mockRepository as unknown as AuditRepository,
    mockHashService as unknown as AuditHashService,
  );

  it('should export audit logs in JSON format with pagination cursor', async () => {
    const mockLogs = [
      {
        id: 'log-1',
        organizationId: 'org-123',
        userId: 'user-1',
        action: 'AGENT_PAYMENT_INITIATED',
        entity: 'Transaction',
        entityId: 'tx-1',
        ipAddress: '127.0.0.1',
        device: 'AgentRunner/1.0',
        oldValue: { amount: 10 },
        newValue: { amount: 20 },
        createdAt: new Date('2026-08-28T10:00:00Z'),
        user: { id: 'user-1', email: 'auditor@example.com', name: 'Auditor' },
      },
    ];

    mockRepository.exportLogs.mockResolvedValueOnce(mockLogs);

    const result = await auditService.export('org-123', {
      format: 'json',
      limit: 10,
      actionType: 'AGENT_PAYMENT_INITIATED',
    });

    expect(result.format).toBe('json');
    expect(result.count).toBe(1);
    expect(result.data).toEqual([
      {
        ...mockLogs[0],
        oldValue: { amount: 10 },
        newValue: { amount: 20 },
      },
    ]);
    expect(mockRepository.exportLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-123',
        action: 'AGENT_PAYMENT_INITIATED',
      }),
      10,
      undefined,
    );
  });

  it('should export audit logs in CSV format properly escaped', async () => {
    const mockLogs = [
      {
        id: 'log-1',
        organizationId: 'org-123',
        userId: 'user-1',
        action: 'POLICY_OVERRIDE,ADMIN',
        entity: 'Policy',
        entityId: 'pol-1',
        ipAddress: '127.0.0.1',
        device: 'Desktop',
        oldValue: { limit: 500 },
        newValue: { limit: 1000 },
        createdAt: new Date('2026-08-28T10:00:00Z'),
        user: { id: 'user-1', email: 'admin@example.com', name: 'Admin' },
      },
    ];

    mockRepository.exportLogs.mockResolvedValueOnce(mockLogs);

    const result = await auditService.export('org-123', {
      format: 'csv',
      limit: 10,
    });

    expect(result.format).toBe('csv');
    expect(typeof result.data).toBe('string');
    expect(result.data).toContain('id,organizationId,userId');
    expect(result.data).toContain('"POLICY_OVERRIDE,ADMIN"');
  });

  it('redacts sensitive nested payload values in JSON and CSV exports', async () => {
    const mockLog = {
      id: 'log-secret',
      organizationId: 'org-123',
      userId: null,
      action: 'wallet.updated',
      entity: 'Wallet',
      entityId: 'wallet-1',
      ipAddress: null,
      device: null,
      oldValue: { credential: { apiKey: 'old-key' }, safe: 'visible' },
      newValue: [{ password: 'secret', amount: 25 }],
      createdAt: new Date('2026-08-28T10:00:00Z'),
      user: null,
    };
    mockRepository.exportLogs.mockResolvedValueOnce([mockLog]);

    const result = await auditService.export('org-123', { format: 'json', limit: 10 });

    if (!Array.isArray(result.data)) throw new Error('Expected JSON export records');
    expect(result.data[0].oldValue).toEqual({
      credential: { apiKey: '[REDACTED]' },
      safe: 'visible',
    });
    expect(result.data[0].newValue).toEqual([{ password: '[REDACTED]', amount: 25 }]);

    mockRepository.exportLogs.mockResolvedValueOnce([mockLog]);
    const csvResult = await auditService.export('org-123', { format: 'csv', limit: 10 });

    expect(csvResult.format).toBe('csv');
    expect(csvResult.data).toContain('[REDACTED]');
    expect(csvResult.data).not.toContain('old-key');
    expect(csvResult.data).not.toContain('password\":\"secret');
  });

  it('streams a complete JSON array in batches and redacts payload fields', async () => {
    const firstRecord = {
      id: 'stream-1',
      organizationId: 'org-123',
      userId: null,
      action: 'wallet.updated',
      entity: 'Wallet',
      entityId: 'wallet-1',
      ipAddress: null,
      device: null,
      oldValue: { token: 'secret' },
      newValue: { amount: 10 },
      createdAt: new Date('2026-08-28T10:00:00Z'),
      user: null,
    };
    mockRepository.streamLogs.mockImplementation(async function* () {
      yield firstRecord;
      yield { ...firstRecord, id: 'stream-2' };
    });

    const stream = auditService.streamExport('org-123', {
      format: 'json',
      batchSize: 1,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const result = JSON.parse(Buffer.concat(chunks).toString());

    expect(result).toHaveLength(2);
    expect(result[0].oldValue).toEqual({ token: '[REDACTED]' });
    expect(mockRepository.streamLogs).toHaveBeenCalledWith(
      { organizationId: 'org-123' },
      1,
      undefined,
    );
  });

  it('streams escaped CSV rows and applies the severity metadata filter', async () => {
    mockRepository.streamLogs.mockImplementation(async function* () {});

    const stream = auditService.streamExport('org-123', {
      format: 'csv',
      batchSize: 25,
      severity: 'critical',
    });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    expect(Buffer.concat(chunks).toString()).toBe(
      'id,organizationId,userId,userEmail,action,entity,entityId,ipAddress,device,oldValue,newValue,createdAt\n',
    );
    expect(mockRepository.streamLogs).toHaveBeenCalledWith(
      {
        organizationId: 'org-123',
        AND: [
          {
            OR: [
              { oldValue: { path: ['severity'], equals: 'critical' } },
              { newValue: { path: ['severity'], equals: 'critical' } },
            ],
          },
        ],
      },
      25,
      undefined,
    );
  });

  it('rejects unknown stream query keys and reversed date ranges', () => {
    expect(() => streamAuditLogsQuerySchema.parse({ unexpected: 'value' })).toThrow();
    expect(() =>
      streamAuditLogsQuerySchema.parse({
        startDate: '2026-08-29T00:00:00.000Z',
        endDate: '2026-08-28T00:00:00.000Z',
      }),
    ).toThrow('endDate must be on or after startDate');
  });

  it('should handle empty records gracefully', async () => {
    mockRepository.exportLogs.mockResolvedValueOnce([]);

    const result = await auditService.export('org-123', {
      format: 'csv',
      limit: 10,
    });

    expect(result.format).toBe('csv');
    expect(result.count).toBe(0);
    expect(result.data).toBe(
      'id,organizationId,userId,userEmail,action,entity,entityId,ipAddress,device,oldValue,newValue,createdAt',
    );
  });
});
