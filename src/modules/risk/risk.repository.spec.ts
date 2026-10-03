import { describe, expect, it, beforeEach, vi } from 'vitest';
import { RiskBand } from '@prisma/client';
import { RiskRepository } from './risk.repository';
import { PrismaService } from '../../database/prisma.service';

describe('RiskRepository', () => {
  let repository: RiskRepository;
  let prisma: PrismaService;

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma = {
      riskAssessment: {
        create: vi.fn(),
        findMany: vi.fn(),
        findUnique: vi.fn(),
      },
    } as unknown as PrismaService;
    repository = new RiskRepository(prisma);
  });

  describe('createAssessmentRecord', () => {
    it('creates a risk assessment record', async () => {
      const mockAssessment = {
        id: 'assessment-1',
        organizationId: 'org-1',
        transactionId: 'tx-1',
        score: 25,
        band: RiskBand.LOW,
        factors: { factors: [] },
        canAutoExecute: true,
        createdAt: new Date(),
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked((prisma as any).riskAssessment.create).mockResolvedValue(mockAssessment);

      const result = await repository.createAssessmentRecord({
        organizationId: 'org-1',
        transactionId: 'tx-1',
        score: 25,
        band: RiskBand.LOW,
        factors: { factors: [] },
        canAutoExecute: true,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((prisma as any).riskAssessment.create).toHaveBeenCalledWith({
        data: {
          organizationId: 'org-1',
          transactionId: 'tx-1',
          score: 25,
          band: RiskBand.LOW,
          factors: { factors: [] },
          canAutoExecute: true,
        },
      });
      expect(result).toEqual(mockAssessment);
    });
  });

  describe('findByOrganization', () => {
    it('returns risk assessments for an organization', async () => {
      const mockAssessments = [
        {
          id: 'assessment-1',
          organizationId: 'org-1',
          transactionId: 'tx-1',
          score: 25,
          band: RiskBand.LOW,
          factors: {},
          canAutoExecute: true,
          createdAt: new Date(),
        },
      ];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked((prisma as any).riskAssessment.findMany).mockResolvedValue(mockAssessments);

      const result = await repository.findByOrganization('org-1', 100);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((prisma as any).riskAssessment.findMany).toHaveBeenCalledWith({
        where: { organizationId: 'org-1' },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      expect(result).toEqual(mockAssessments);
    });
  });

  describe('findByTransaction', () => {
    it('returns risk assessment by transaction ID', async () => {
      const mockAssessment = {
        id: 'assessment-1',
        organizationId: 'org-1',
        transactionId: 'tx-1',
        score: 25,
        band: RiskBand.LOW,
        factors: {},
        canAutoExecute: true,
        createdAt: new Date(),
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked((prisma as any).riskAssessment.findUnique).mockResolvedValue(mockAssessment);

      const result = await repository.findByTransaction('tx-1');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((prisma as any).riskAssessment.findUnique).toHaveBeenCalledWith({
        where: { transactionId: 'tx-1' },
      });
      expect(result).toEqual(mockAssessment);
    });
  });

  describe('getStatistics', () => {
    it('calculates risk statistics for an organization', async () => {
      const mockAssessments = [
        {
          id: 'assessment-1',
          organizationId: 'org-1',
          transactionId: 'tx-1',
          score: 10,
          band: RiskBand.LOW,
          factors: {},
          canAutoExecute: true,
          createdAt: new Date(),
        },
        {
          id: 'assessment-2',
          organizationId: 'org-1',
          transactionId: 'tx-2',
          score: 35,
          band: RiskBand.MEDIUM,
          factors: {},
          canAutoExecute: true,
          createdAt: new Date(),
        },
        {
          id: 'assessment-3',
          organizationId: 'org-1',
          transactionId: 'tx-3',
          score: 90,
          band: RiskBand.CRITICAL,
          factors: {},
          canAutoExecute: false,
          createdAt: new Date(),
        },
      ];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked((prisma as any).riskAssessment.findMany).mockResolvedValue(mockAssessments);

      const result = await repository.getStatistics('org-1', 30);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((prisma as any).riskAssessment.findMany).toHaveBeenCalledWith({
        where: {
          organizationId: 'org-1',
          createdAt: expect.objectContaining({
            gte: expect.any(Date),
          }),
        },
      });
      expect(result.total).toBe(3);
      expect(result.averageScore).toBe(45);
      expect(result.byBand.LOW).toBe(1);
      expect(result.byBand.MEDIUM).toBe(1);
      expect(result.byBand.HIGH).toBe(0);
      expect(result.byBand.CRITICAL).toBe(1);
      expect(result.autoExecuteRate).toBe(2 / 3);
    });

    it('handles empty results', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked((prisma as any).riskAssessment.findMany).mockResolvedValue([]);

      const result = await repository.getStatistics('org-1', 30);

      expect(result.total).toBe(0);
      expect(result.averageScore).toBe(0);
      expect(result.autoExecuteRate).toBe(0);
    });
  });
});
