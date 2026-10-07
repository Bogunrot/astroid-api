import { Inject, Injectable, Logger } from '@nestjs/common';
import { ErrorCode } from '../../../common/constants/error-codes';
import { DomainException } from '../../../common/exceptions/domain.exception';
import { CircuitBreaker, isRpcFailure } from '../../../common/circuit-breaker/circuit-breaker';
import {
  BuildPaymentParams,
  StellarBalance,
  StellarClient,
  StellarKeypair,
  StellarNetworkName,
  StellarSubmitResult,
  StellarTransactionInfo,
  SubmitPaymentParams,
  STELLAR_CLIENT,
  SOROBAN_CLIENT,
  SorobanClient,
  SorobanSimulationResult,
} from '../../../integrations/stellar';

const HORIZON_FAILURE_THRESHOLD = 5;
const HORIZON_RESET_TIMEOUT_MS = 30_000;

@Injectable()
export class StellarService {
  private readonly logger = new Logger(StellarService.name);
  private readonly breaker = new CircuitBreaker({
    name: 'horizon',
    failureThreshold: HORIZON_FAILURE_THRESHOLD,
    resetTimeoutMs: HORIZON_RESET_TIMEOUT_MS,
    isFailure: isRpcFailure,
  });

  constructor(
    @Inject(STELLAR_CLIENT) private readonly client: StellarClient,
    @Inject(SOROBAN_CLIENT) private readonly sorobanClient: SorobanClient,
  ) {}

  generateKeypair(): StellarKeypair {
    return this.client.generateKeypair();
  }

  assertValidAddress(address: string): void {
    if (!this.client.isValidAddress(address)) {
      throw new DomainException(
        ErrorCode.INVALID_STELLAR_ADDRESS,
        `'${address}' is not a valid Stellar address`,
      );
    }
  }

  isValidAddress(address: string): boolean {
    return this.client.isValidAddress(address);
  }

  async getBalances(address: string, network: StellarNetworkName): Promise<StellarBalance[]> {
    return this.wrap(() => this.client.getBalances(address, network));
  }

  async getNativeBalance(address: string, network: StellarNetworkName): Promise<string> {
    return this.wrap(() => this.client.getNativeBalance(address, network));
  }

  async buildPaymentXdr(params: BuildPaymentParams): Promise<string> {
    return this.wrap(() => this.client.buildPaymentXdr(params));
  }

  async submitPayment(params: SubmitPaymentParams): Promise<StellarSubmitResult> {
    return this.wrap(() => this.client.submitPayment(params));
  }

  async getTransactionInfo(txHash: string, network: StellarNetworkName): Promise<StellarTransactionInfo> {
    return this.wrap(async () => {
      const info = await this.client.getTransaction(txHash, network);
      if (!info) {
        throw new DomainException(ErrorCode.NOT_FOUND, `Transaction '${txHash}' not found`);
      }
      return info;
    });
  }

  async simulateTransaction(transactionXdr: string): Promise<SorobanSimulationResult> {
    if (!transactionXdr || typeof transactionXdr !== 'string') {
      throw new DomainException(
        ErrorCode.INVALID_STELLAR_TRANSACTION,
        'Invalid or malformed transaction XDR string',
      );
    }

    try {
      return await this.breaker.execute(async () => {
        const result = await this.sorobanClient.simulateTransaction({ transactionXdr });
        if (!result.success || result.error) {
          throw new DomainException(
            ErrorCode.STELLAR_ERROR,
            `Simulation failed: ${result.error?.message ?? 'Unknown simulation error'}`,
          );
        }
        return result;
      });
    } catch (error: unknown) {
      if (error instanceof DomainException) {
        throw error;
      }
      const errMessage = error instanceof Error ? error.message : 'Unknown simulation error';
      this.logger.error(
        `Stellar transaction simulation failed: ${errMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new DomainException(
        ErrorCode.STELLAR_ERROR,
        `Failed to simulate Stellar transaction: ${errMessage}`,
      );
    }
  }

  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await this.breaker.execute(fn);
    } catch (error: unknown) {
      if (error instanceof DomainException) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'Unknown Stellar error';
      throw new DomainException(ErrorCode.STELLAR_ERROR, `Stellar operation failed: ${message}`);
    }
  }
}
