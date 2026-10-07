import { Injectable, Logger } from '@nestjs/common';
import { RiskEngine } from './risk.engine';
import { RiskAssessment, RiskConfig, RiskFactorsInput, RiskRule } from './risk.types';
import { EventBusService } from '../../events/event-bus.service';
import { DomainEventName } from '../../events/event-names';
import { RiskRepository } from './risk.repository';
import { TypedOnEvent } from '../../events/typed-event-listener.decorator';
import { DomainEventEnvelope } from '../../events/domain-event.types';

/**
 * Application-facing risk service. Wraps the pure {@link RiskEngine}, emits a
 * RiskEvaluated domain event (with full factor breakdown for audit metadata),
 * persists assessment records for compliance, and is called by the transactions pipeline.
 */
@Injectable()
export class RiskService {
  private readonly logger = new Logger(RiskService.name);
  private readonly processedEvents = new Set<string>();

  constructor(
    private readonly engine: RiskEngine,
    private readonly eventBus: EventBusService,
    private readonly repository: RiskRepository,
  ) {}

  /**
   * Full evaluation with event emission and persistence. The emitted event payload includes
   * the complete factor breakdown so the audit listener captures it as metadata.
   * Assessment records are persisted for compliance reporting and pattern analysis.
   */
  async evaluate(
    organizationId: string,
    input: RiskFactorsInput,
    context: {
      transactionId?: string;
      actorId?: string;
      config?: Partial<RiskConfig>;
      rules?: RiskRule[];
    } = {},
  ): Promise<RiskAssessment> {
    const assessment = this.engine.assess(input, context.config, context.rules);

    await this.eventBus.emit(
      DomainEventName.RiskEvaluated,
      {
        transactionId: context.transactionId,
        score: assessment.score,
        band: assessment.band,
        factors: assessment.factors,
        canAutoExecute: assessment.canAutoExecute,
      },
      {
        organizationId,
        actorId: context.actorId,
        aggregateType: 'transaction',
        aggregateId: context.transactionId,
      },
    );

    if (context.transactionId) {
      await this.repository.createAssessmentRecord({
        organizationId,
        transactionId: context.transactionId,
        score: assessment.score,
        band: assessment.band,
        factors: { factors: assessment.factors },
        canAutoExecute: assessment.canAutoExecute,
      });
    }

    return assessment;
  }

  /** Synchronous assessment without event emission or persistence (used by simulate). */
  assess(
    input: RiskFactorsInput,
    config?: Partial<RiskConfig>,
    rules?: RiskRule[],
  ): RiskAssessment {
    return this.engine.assess(input, config, rules);
  }

  async getHistory(organizationId: string, limit = 100) {
    return this.repository.findByOrganization(organizationId, limit);
  }

  @TypedOnEvent(DomainEventName.TransactionCreated)
  async handleTransactionCreated(
    envelope: DomainEventEnvelope<{
      transactionId: string;
      walletId?: string;
      amount?: string;
      asset?: string;
    }>,
  ): Promise<void> {
    const transactionId = envelope.payload?.transactionId;
    if (!transactionId) {
      return;
    }

    const dedupKey = `${transactionId}:${envelope.occurredAt?.getTime() || 0}`;
    if (this.processedEvents.has(dedupKey)) {
      this.logger.debug(
        `Duplicate transaction created event detected for transaction ${transactionId}, skipping.`,
      );
      return;
    }
    this.processedEvents.add(dedupKey);
    if (this.processedEvents.size > 5000) {
      const firstKey = this.processedEvents.values().next().value;
      if (firstKey) {
        this.processedEvents.delete(firstKey);
      }
    }

    const organizationId = envelope.organizationId || 'default-org';
    try {
      const amountNum = envelope.payload?.amount ? parseFloat(envelope.payload.amount) : 0;
      const riskInput: RiskFactorsInput = {
        amount: amountNum,
        asset: envelope.payload?.asset ?? 'XLM',
        knownRecipient: false,
        recentTransactionCount: 1,
        walletAgeDays: 0,
        policyViolations: 0,
      };

      await this.evaluate(organizationId, riskInput, {
        transactionId,
        actorId: envelope.actorId,
      });
      this.logger.log(
        `Successfully scored risk for transaction ${transactionId} via event handler.`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to handle risk scoring for transaction ${transactionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  async getStatistics(organizationId: string, days = 30) {
    return this.repository.getStatistics(organizationId, days);
  }
}
