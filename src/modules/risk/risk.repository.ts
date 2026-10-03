import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { RiskBand } from '@prisma/client';

interface RiskAssessment {
  id: string;
  organizationId: string;
  transactionId: string;
  score: number;
  band: RiskBand;
  factors: Record<string, unknown>;
  canAutoExecute: boolean;
  createdAt: Date;
}

/**
 * Repository for risk assessment persistence and historical analysis.
 * Stores risk evaluation results for compliance reporting and pattern detection.
 */
@Injectable()
export class RiskRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record a risk assessment result for audit trail compliance.
   */
  async createAssessmentRecord(data: {
    organizationId: string;
    transactionId: string;
    score: number;
    band: RiskBand;
    factors: Record<string, unknown>;
    canAutoExecute: boolean;
  }) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.prisma as any).riskAssessment.create({
      data: {
        organizationId: data.organizationId,
        transactionId: data.transactionId,
        score: data.score,
        band: data.band,
        factors: data.factors,
        canAutoExecute: data.canAutoExecute,
      },
    });
  }

  /**
   * Get historical risk assessments for an organization.
   */
  async findByOrganization(organizationId: string, limit = 100) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.prisma as any).riskAssessment.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Get risk assessment by transaction ID.
   */
  async findByTransaction(transactionId: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.prisma as any).riskAssessment.findUnique({
      where: { transactionId },
    });
  }

  /**
   * Get risk statistics for an organization.
   */
  async getStatistics(organizationId: string, days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const assessments = await (this.prisma as any).riskAssessment.findMany({
      where: {
        organizationId,
        createdAt: { gte: since },
      },
    });

    const total = assessments.length;
    const byBand = {
      LOW: assessments.filter((a: RiskAssessment) => a.band === RiskBand.LOW).length,
      MEDIUM: assessments.filter((a: RiskAssessment) => a.band === RiskBand.MEDIUM).length,
      HIGH: assessments.filter((a: RiskAssessment) => a.band === RiskBand.HIGH).length,
      CRITICAL: assessments.filter((a: RiskAssessment) => a.band === RiskBand.CRITICAL).length,
    };

    const avgScore =
      total > 0 ? assessments.reduce((sum: number, a: RiskAssessment) => sum + a.score, 0) / total : 0;

    return {
      total,
      averageScore: Math.round(avgScore),
      byBand,
      autoExecuteRate: total > 0 ? assessments.filter((a: RiskAssessment) => a.canAutoExecute).length / total : 0,
    };
  }
}
