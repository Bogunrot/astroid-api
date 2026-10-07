import { Test, TestingModule } from '@nestjs/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StellarService } from '../services/stellar.service';
import {
  STELLAR_CLIENT,
  SOROBAN_CLIENT,
  StellarClient,
  SorobanClient,
  SorobanSimulationResult,
} from '../../../integrations/stellar';
import { DomainException } from '../../../common/exceptions/domain.exception';
import { ErrorCode } from '../../../common/constants/error-codes';

describe('StellarService - Transaction Simulation', () => {
  let service: StellarService;
  let mockSorobanClient: SorobanClient;
  let mockStellarClient: StellarClient;

  beforeEach(async () => {
    mockSorobanClient = {
      simulateTransaction: vi.fn(),
    } as unknown as SorobanClient;

    mockStellarClient = {
      generateKeypair: vi.fn(),
      isValidAddress: vi.fn().mockReturnValue(true),
      getBalances: vi.fn(),
      getNativeBalance: vi.fn(),
      buildPaymentXdr: vi.fn(),
      submitPayment: vi.fn(),
      getTransactionInfo: vi.fn(),
    } as unknown as StellarClient;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StellarService,
        {
          provide: STELLAR_CLIENT,
          useValue: mockStellarClient,
        },
        {
          provide: SOROBAN_CLIENT,
          useValue: mockSorobanClient,
        },
      ],
    }).compile();

    service = module.get<StellarService>(StellarService);
  });

  it('should successfully simulate a valid transaction XDR', async () => {
    const mockResult: SorobanSimulationResult = {
      success: true,
      minResourceFee: '100',
      cost: { cpuInstructions: 0, memoryBytes: 0 },
      footprint: { readOnly: [], readWrite: [] },
      events: [],
      result: 'AAAA...',
    };
    vi.spyOn(mockSorobanClient, 'simulateTransaction').mockResolvedValueOnce(mockResult);

    const result = await service.simulateTransaction('AAAA...valid_xdr');
    expect(result).toEqual(mockResult);
    expect(mockSorobanClient.simulateTransaction).toHaveBeenCalledWith({
      transactionXdr: 'AAAA...valid_xdr',
    });
  });

  it('should throw DomainException when transaction XDR is empty or invalid', async () => {
    try {
      await service.simulateTransaction('');
      expect.unreachable('expected simulateTransaction to throw');
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DomainException);
      const err = e as DomainException;
      expect(err.code).toBe(ErrorCode.INVALID_STELLAR_TRANSACTION);
    }
  });

  it('should handle simulation failure and Soroban error codes correctly', async () => {
    const errorResult: SorobanSimulationResult = {
      success: false,
      minResourceFee: '0',
      cost: { cpuInstructions: 0, memoryBytes: 0 },
      footprint: { readOnly: [], readWrite: [] },
      events: [],
      error: { code: 'HOST_ERROR', message: 'HostError: Error(Contract, #4)' },
    };
    vi.spyOn(mockSorobanClient, 'simulateTransaction').mockResolvedValueOnce(errorResult);

    const error = await service.simulateTransaction('AAAA...trap_xdr').catch(
      (reason: unknown) => reason as DomainException,
    );
    expect(error).toBeInstanceOf(DomainException);
    expect((error as DomainException).code).toBe(ErrorCode.STELLAR_ERROR);
    expect((error as DomainException).message).toContain('HostError: Error(Contract, #4)');
  });

  it('should handle RPC network timeouts and errors robustly', async () => {
    vi.spyOn(mockSorobanClient, 'simulateTransaction').mockRejectedValueOnce(new Error('RPC timeout'));

    const error = await service.simulateTransaction('AAAA...timeout_xdr').catch(
      (reason: unknown) => reason as DomainException,
    );
    expect(error).toBeInstanceOf(DomainException);
    expect((error as DomainException).code).toBe(ErrorCode.STELLAR_ERROR);
    expect((error as DomainException).message).toContain('RPC timeout');
  });
});
