import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StellarSimulationService } from './stellar-simulation.service';
import { SorobanClient, SorobanSimulationResult } from '../../../integrations/stellar/soroban.interface';
import { RiskEngine } from '../../risk/risk.engine';
import { EventBusService } from '../../../events/event-bus.service';
import { CircuitOpenException, DomainException } from '../../../common/exceptions/domain.exception';
import { ErrorCode } from '../../../common/constants/error-codes';

function buildMockSorobanClient(overrides: Partial<SorobanSimulationResult> = {}): SorobanClient {
  return {
    simulateTransaction: vi.fn().mockResolvedValue({
      success: true,
      minResourceFee: '100000',
      cost: { cpuInstructions: 200_000, memoryBytes: 4096 },
      footprint: {
        readOnly: [{ contractId: 'contract-1', key: { symbol: 'Balance' } }],
        readWrite: [],
      },
      events: [],
      result: undefined,
      transactionHash: 'mock-hash-123',
      ...overrides,
    } as SorobanSimulationResult),
  };
}

function buildMockEventBus() {
  return { emit: vi.fn().mockResolvedValue(undefined) };
}

function buildValidXdr(): string {
  return Buffer.from(
    JSON.stringify({ source: 'GABC...', destination: 'GDEF...', amount: '100' }),
  ).toString('base64');
}

describe('StellarSimulationService', () => {
  let sorobanClient: ReturnType<typeof buildMockSorobanClient>;
  let eventBus: ReturnType<typeof buildMockEventBus>;
  let service: StellarSimulationService;

  beforeEach(() => {
    vi.clearAllMocks();
    sorobanClient = buildMockSorobanClient();
    eventBus = buildMockEventBus();
    service = new StellarSimulationService(
      sorobanClient,
      new RiskEngine(),
      eventBus as unknown as EventBusService,
    );
  });

  describe('simulate', () => {
    it('should return simulation results with risk assessment', async () => {
      const result = await service.simulate({
        transactionXdr: buildValidXdr(),
        organizationId: 'org-1',
      });

      expect(result.success).toBe(true);
      expect(result.feeEstimate).toBe('100000');
      expect(result.risk).toBeDefined();
      expect(result.risk.score).toBeGreaterThanOrEqual(0);
      expect(result.risk.score).toBeLessThanOrEqual(100);
      expect(result.transactionHash).toBe('mock-hash-123');
    });

    it('should emit a risk evaluation event', async () => {
      await service.simulate({
        transactionXdr: buildValidXdr(),
        organizationId: 'org-1',
        actorId: 'user-1',
      });

      expect(eventBus.emit).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ score: expect.any(Number) }),
        expect.objectContaining({ organizationId: 'org-1', actorId: 'user-1' }),
      );
    });

    it('should throw DomainException for invalid base64 XDR', async () => {
      await expect(
        service.simulate({
          transactionXdr: '!!!not-base64-at-all&&&',
          organizationId: 'org-1',
        }),
      ).rejects.toThrow('not valid base64');
    });

    it('should throw DomainException for empty XDR', async () => {
      await expect(
        service.simulate({
          transactionXdr: '',
          organizationId: 'org-1',
        }),
      ).rejects.toThrow('Transaction XDR is required');
    });

    it('should throw DomainException when simulation returns failure', async () => {
      (sorobanClient.simulateTransaction as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        minResourceFee: '0',
        cost: { cpuInstructions: 0, memoryBytes: 0 },
        footprint: { readOnly: [], readWrite: [] },
        events: [],
        error: { code: 'txFailed', message: 'Contract Error' },
      });

      await expect(
        service.simulate({
          transactionXdr: buildValidXdr(),
          organizationId: 'org-1',
        }),
      ).rejects.toThrow('Contract Error');
    });

    it('should throw DomainException when soroban client throws', async () => {
      (sorobanClient.simulateTransaction as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Connection refused'),
      );

      await expect(
        service.simulate({
          transactionXdr: buildValidXdr(),
          organizationId: 'org-1',
        }),
      ).rejects.toThrow('Stellar simulation failed');
    });

    it('should throw RiskTooHighException when risk exceeds threshold', async () => {
      await expect(
        service.simulate({
          transactionXdr: buildValidXdr(),
          organizationId: 'org-1',
          maxRiskScore: -1,
        }),
      ).rejects.toThrow('exceeds maximum allowed');
    });

    it('should include risk factors when provided', async () => {
      const result = await service.simulate({
        transactionXdr: buildValidXdr(),
        organizationId: 'org-1',
        riskFactors: {
          amount: 5000,
          asset: 'USDC',
          knownRecipient: true,
          recentTransactionCount: 2,
          walletAgeDays: 180,
          policyViolations: 0,
        },
      });

      expect(result.risk.score).toBeGreaterThanOrEqual(0);
      expect(result.risk.factors).toBeDefined();
    });

    it('should indicate requiresApproval when risk is above LOW', async () => {
      const result = await service.simulate({
        transactionXdr: buildValidXdr(),
        organizationId: 'org-1',
        maxRiskScore: 100,
        riskFactors: {
          amount: 50000,
          asset: 'XLM',
          knownRecipient: false,
          recentTransactionCount: 15,
          walletAgeDays: 5,
          policyViolations: 2,
        },
      });

      expect(result.requiresApproval).toBe(true);
    });
  });

  describe('simulateWithDefaults', () => {
    it('should call simulate with maxRiskScore of 80', async () => {
      const simulateSpy = vi.spyOn(service, 'simulate');
      
      const input = {
        transactionXdr: buildValidXdr(),
        organizationId: 'org-1',
      };

      await service.simulateWithDefaults(input);

      expect(simulateSpy).toHaveBeenCalledWith({
        ...input,
        maxRiskScore: 80,
      });
    });

    it('should override maxRiskScore if already provided', async () => {
      const simulateSpy = vi.spyOn(service, 'simulate');
      
      const input = {
        transactionXdr: buildValidXdr(),
        organizationId: 'org-1',
        maxRiskScore: 50,
      };

      await service.simulateWithDefaults(input);

      expect(simulateSpy).toHaveBeenCalledWith({
        ...input,
        maxRiskScore: 80,
      });
    });
  });

  describe('validateXdrFormat', () => {
    it('should return true for valid base64 XDR', () => {
      const validXdr = buildValidXdr();
      expect(service.validateXdrFormat(validXdr)).toBe(true);
    });

    it('should return false for empty string', () => {
      expect(service.validateXdrFormat('')).toBe(false);
    });

    it('should return false for null', () => {
      expect(service.validateXdrFormat(null as unknown as string)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(service.validateXdrFormat(undefined as unknown as string)).toBe(false);
    });

    it('should return false for invalid base64 characters', () => {
      expect(service.validateXdrFormat('!!!not-base64!!!')).toBe(false);
    });

    it('should return false for malformed base64', () => {
      expect(service.validateXdrFormat('AB=C')).toBe(false);
    });

    it('should return true for base64url format', () => {
      const base64url = 'ABCdef-123_456==';
      expect(service.validateXdrFormat(base64url)).toBe(true);
    });

    it('should return true for standard base64', () => {
      const standardBase64 = 'ABCdef+123/456==';
      expect(service.validateXdrFormat(standardBase64)).toBe(true);
    });

    it('should return true for base64 without padding', () => {
      const noPadding = 'ABCdef123456';
      expect(service.validateXdrFormat(noPadding)).toBe(true);
    });

    it('should return false for non-string input', () => {
      expect(service.validateXdrFormat(123 as unknown as string)).toBe(false);
      expect(service.validateXdrFormat({} as unknown as string)).toBe(false);
      expect(service.validateXdrFormat([] as unknown as string)).toBe(false);
    });
  });

  describe('circuit breaker integration', () => {
    it('opens the Stellar circuit after repeated RPC failures and fails fast without calling the client again', async () => {
      (sorobanClient.simulateTransaction as ReturnType<typeof vi.fn>).mockRejectedValue(
        Object.assign(new Error('Stellar RPC unreachable'), { code: 'ECONNREFUSED' }),
      );

      for (let i = 0; i < 5; i++) {
        await expect(
          service.simulate({ transactionXdr: buildValidXdr(), organizationId: 'org-1' }),
        ).rejects.toMatchObject({ code: ErrorCode.STELLAR_ERROR });
      }
      expect(sorobanClient.simulateTransaction).toHaveBeenCalledTimes(5);

      (sorobanClient.simulateTransaction as ReturnType<typeof vi.fn>).mockClear();

      let thrown: unknown;
      try {
        await service.simulate({ transactionXdr: buildValidXdr(), organizationId: 'org-1' });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(CircuitOpenException);
      expect(thrown).toBeInstanceOf(DomainException);
      expect((thrown as DomainException).code).toBe(ErrorCode.CIRCUIT_OPEN);
      expect(sorobanClient.simulateTransaction).not.toHaveBeenCalled();
    });
  });

  describe('integration scenarios', () => {
    it('should handle complete simulation workflow', async () => {
      // Step 1: Validate XDR format
      const xdr = buildValidXdr();
      expect(service.validateXdrFormat(xdr)).toBe(true);

      // Step 2: Simulate with defaults
      const result = await service.simulateWithDefaults({
        transactionXdr: xdr,
        organizationId: 'org-1',
        actorId: 'user-1',
      });

      expect(result.success).toBe(true);
      expect(result.risk.score).toBeLessThanOrEqual(80);
    });

    it('should handle validation before simulation to catch format errors early', async () => {
      const invalidXdr = '!!!invalid-xdr!!!';
      
      // Early validation
      expect(service.validateXdrFormat(invalidXdr)).toBe(false);

      // Simulation would fail, but we caught it early
      const validXdr = buildValidXdr();
      expect(service.validateXdrFormat(validXdr)).toBe(true);
    });
  });
});
