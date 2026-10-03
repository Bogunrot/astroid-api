import { Injectable, Logger, Inject } from '@nestjs/common';
import {
  SOROBAN_CLIENT,
  SorobanClient,
  SorobanSimulationResult,
} from '../../../integrations/stellar/soroban.interface';
import { RiskEngine } from '../../risk/risk.engine';
import { RiskAssessment, RiskFactorsInput } from '../../risk/risk.types';
import { ErrorCode } from '../../../common/constants/error-codes';
import {
  DomainException,
  RiskTooHighException,
} from '../../../common/exceptions/domain.exception';
import { CircuitBreaker, isRpcFailure } from '../../../common/circuit-breaker/circuit-breaker';
import { EventBusService } from '../../../events/event-bus.service';
import { DomainEventName } from '../../../events/event-names';

/** Consecutive failures before the Soroban RPC circuit trips OPEN. */
const SOROBAN_FAILURE_THRESHOLD = 5;
/** Time the Soroban RPC circuit stays OPEN before a HALF_OPEN trial call. */
const SOROBAN_RESET_TIMEOUT_MS = 30_000;

export interface SimulationInput {
  /** The base64-encoded transaction envelope XDR. */
  transactionXdr: string;
  /** Organization ID for risk context. */
  organizationId: string;
  /** Optional actor ID for audit context. */
  actorId?: string;
  /** Optional risk factors for scoring (if not provided, uses defaults). */
  riskFactors?: RiskFactorsInput;
  /** Maximum allowed risk score before simulation is rejected. */
  maxRiskScore?: number;
}

export interface SimulationOutput {
  /** Whether the simulation succeeded. */
  success: boolean;
  /** Fee estimate in stroops. */
  feeEstimate: string;
  /** Resource cost analysis. */
  cost: {
    cpuInstructions: number;
    memoryBytes: number;
  };
  /** Footprint data from the simulation. */
  footprint: SorobanSimulationResult['footprint'];
  /** Events emitted during simulation. */
  events: SorobanSimulationResult['events'];
  /** Risk assessment of the simulated transaction. */
  risk: RiskAssessment;
  /** Whether the transaction requires approval based on risk. */
  requiresApproval: boolean;
  /** Error details if simulation failed. */
  error?: SorobanSimulationResult['error'];
  /** Transaction hash from simulation. */
  transactionHash?: string;
}

/**
 * Stellar Transaction Simulation Service.
 * 
 * This service provides a unified interface for Stellar transaction simulation,
 * handling both classic Stellar and Soroban smart contract transactions.
 * It validates XDR, simulates execution on the Stellar network (via RPC),
 * and returns detailed diagnostic information including fee estimates,
 * resource costs, and risk assessment.
 * 
 * This is a dedicated service that mirrors the functionality of SorobanSimulationService
 * to provide a more generic Stellar simulation interface as requested in issue #246.
 */
@Injectable()
export class StellarSimulationService {
  private readonly logger = new Logger(StellarSimulationService.name);
  private readonly breaker = new CircuitBreaker({
    name: 'stellar-simulation',
    failureThreshold: SOROBAN_FAILURE_THRESHOLD,
    resetTimeoutMs: SOROBAN_RESET_TIMEOUT_MS,
    isFailure: isRpcFailure,
  });

  constructor(
    @Inject(SOROBAN_CLIENT) private readonly sorobanClient: SorobanClient,
    private readonly riskEngine: RiskEngine,
    private readonly eventBus: EventBusService,
  ) {}

  /**
   * Simulates a Stellar transaction before submission to the network.
   * 
   * This method validates the transaction XDR, simulates execution on the
   * Stellar network (via RPC), and returns detailed diagnostic information
   * including fee estimates, resource costs, and risk assessment.
   * 
   * @param input - Simulation parameters including transaction XDR and organization context
   * @returns Simulation output with success status, fee estimate, cost analysis, and risk assessment
   * @throws DomainException if the XDR is invalid or simulation fails
   * @throws RiskTooHighException if the risk score exceeds the allowed threshold
   */
  async simulate(input: SimulationInput): Promise<SimulationOutput> {
    this.logger.debug(
      `Simulating Stellar transaction for organization ${input.organizationId}`,
    );

    this.validateXdr(input.transactionXdr);

    let result: SorobanSimulationResult;
    try {
      result = await this.breaker.execute(() =>
        this.sorobanClient.simulateTransaction({
          transactionXdr: input.transactionXdr,
        }),
      );
    } catch (error) {
      if (error instanceof DomainException) {
        throw error;
      }
      this.logger.warn(
        `Stellar simulation failed: ${(error as Error).message}`,
      );
      throw new DomainException(
        ErrorCode.STELLAR_ERROR,
        `Stellar simulation failed: ${(error as Error).message}`,
      );
    }

    if (!result.success) {
      this.logger.warn(
        `Stellar simulation returned error: ${result.error?.code} - ${result.error?.message}`,
      );
      throw new DomainException(
        ErrorCode.STELLAR_ERROR,
        `Stellar simulation failed: ${result.error?.message ?? 'Unknown error'}`,
        result.error,
      );
    }

    // Risk scoring
    const riskInput = input.riskFactors ?? this.buildDefaultRiskFactors(result);
    const risk = this.riskEngine.assess(riskInput);
    const maxRiskScore = input.maxRiskScore ?? 80;
    const requiresApproval = risk.score > 20 || risk.band !== 'LOW';

    if (risk.score > maxRiskScore) {
      throw new RiskTooHighException(
        `Risk score ${risk.score} exceeds maximum allowed threshold of ${maxRiskScore}`,
        { score: risk.score, band: risk.band, maxRiskScore },
      );
    }

    // Emit simulation event for telemetry
    await this.eventBus.emit(
      DomainEventName.RiskEvaluated,
      {
        score: risk.score,
        band: risk.band,
        simulationSuccess: true,
        feeEstimate: result.minResourceFee,
        transactionHash: result.transactionHash,
      },
      {
        organizationId: input.organizationId,
        actorId: input.actorId,
        aggregateType: 'transaction',
      },
    );

    this.logger.debug(
      `Simulation completed: success=${result.success}, fee=${result.minResourceFee}, risk=${risk.score}`,
    );

    return {
      success: true,
      feeEstimate: result.minResourceFee,
      cost: result.cost,
      footprint: result.footprint,
      events: result.events,
      risk,
      requiresApproval,
      transactionHash: result.transactionHash,
    };
  }

  /**
   * Simulates a transaction with default risk thresholds.
   * 
   * This is a convenience method that uses the system's default maximum
   * risk score (80) for the simulation.
   * 
   * @param input - Simulation parameters
   * @returns Simulation output with diagnostic information
   */
  async simulateWithDefaults(input: SimulationInput): Promise<SimulationOutput> {
    return this.simulate({
      ...input,
      maxRiskScore: 80,
    });
  }

  /**
   * Validates transaction XDR format without executing simulation.
   * 
   * This lightweight validation checks that the XDR is properly formatted
   * base64-encoded data, which can be used for early client-side validation.
   * 
   * @param transactionXdr - Base64-encoded transaction envelope XDR
   * @returns true if the XDR format is valid, false otherwise
   */
  validateXdrFormat(transactionXdr: string): boolean {
    if (!transactionXdr || typeof transactionXdr !== 'string') {
      return false;
    }

    // Validate base64url/base64 format
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(transactionXdr)) {
      return false;
    }

    try {
      Buffer.from(transactionXdr, 'base64');
      return true;
    } catch {
      return false;
    }
  }

  private validateXdr(xdr: string): void {
    if (!xdr || typeof xdr !== 'string') {
      throw new DomainException(
        ErrorCode.VALIDATION_ERROR,
        'Transaction XDR is required',
      );
    }
    // Validate base64url/base64 format
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(xdr)) {
      throw new DomainException(
        ErrorCode.INVALID_STELLAR_TRANSACTION,
        'Transaction XDR is not valid base64',
      );
    }
    try {
      Buffer.from(xdr, 'base64');
    } catch {
      throw new DomainException(
        ErrorCode.INVALID_STELLAR_TRANSACTION,
        'Transaction XDR is not valid base64',
      );
    }
  }

  private buildDefaultRiskFactors(result: SorobanSimulationResult): RiskFactorsInput {
    // Build risk factors from simulation result when not explicitly provided
    const eventCount = result.events.length;
    const hasWriteFootprint = result.footprint.readWrite.length > 0;
    const feeStroops = parseInt(result.minResourceFee, 10);

    // Heuristic: higher resource usage correlates with higher risk
    const normalizedFee = Math.min(feeStroops / 10_000_000, 1);
    const amountEstimate = normalizedFee * 10_000;

    return {
      amount: amountEstimate,
      asset: 'XLM',
      knownRecipient: !hasWriteFootprint,
      recentTransactionCount: eventCount,
      walletAgeDays: 90,
      policyViolations: 0,
      hourUtc: new Date().getUTCHours(),
    };
  }
}
