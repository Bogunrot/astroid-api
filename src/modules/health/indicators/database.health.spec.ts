import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseHealthIndicator } from './database.health';
import { PrismaService } from '../../../database/prisma.service';

describe('DatabaseHealthIndicator', () => {
  let prisma: { $queryRaw: ReturnType<typeof vi.fn> };
  let indicator: DatabaseHealthIndicator;

  beforeEach(() => {
    prisma = { $queryRaw: vi.fn() };
    indicator = new DatabaseHealthIndicator(prisma as unknown as PrismaService);
  });

  it('returns UP when query succeeds', async () => {
    prisma.$queryRaw.mockResolvedValue([{ 1: 1 }]);
    const report = await indicator.checkHealth();
    expect(report.status).toBe('up');
    expect(report.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns DOWN when query fails', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('DB offline'));
    const report = await indicator.checkHealth();
    expect(report.status).toBe('down');
    expect(report.error).toContain('DB offline');
  });
});
