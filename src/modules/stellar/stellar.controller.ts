import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiBearerAuth,
  ApiResponse,
  ApiBody,
} from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { StellarConfig } from '../../config/stellar.config';
import { SorobanValidationPipe } from '../../common/pipes/soroban-validation.pipe';
import {
  sorobanInvocationSchema,
  sorobanTransactionSchema,
  SorobanInvocationDto,
  SorobanTransactionDto,
  SorobanResponseDto,
} from './dto/soroban.dto';

/**
 * Read-only informational endpoints for the Stellar integration. Payment and
 * balance operations are exposed through the wallets module.
 */
@ApiTags('stellar')
@ApiBearerAuth('access-token')
@Controller('stellar')
export class StellarController {
  constructor(private readonly config: ConfigService) {}

  @Get('network')
  @ApiOperation({
    summary: 'Returns the configured Stellar network + mode',
    description:
      'Returns the current Stellar network configuration including the Horizon URL ' +
      'and whether the integration is running in mock mode.',
  })
  @ApiResponse({
    status: 200,
    description: 'Stellar network configuration',
    schema: {
      type: 'object',
      properties: {
        network: { type: 'string', example: 'TESTNET', description: 'Stellar network name' },
        horizonUrl: { type: 'string', example: 'https://horizon-testnet.stellar.org', description: 'Horizon server URL' },
        mock: { type: 'boolean', example: false, description: 'Whether running in mock mode' },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  getNetwork(): { network: string; horizonUrl: string; mock: boolean } {
    const stellar = this.config.getOrThrow<StellarConfig>('stellar');
    return {
      network: stellar.network,
      horizonUrl: stellar.horizonUrl,
      mock: stellar.useMock,
    };
  }

  @Post('soroban/invoke')
  @ApiOperation({
    summary: 'Invoke a Soroban smart contract function',
    description:
      'Validates and prepares a Soroban contract invocation. ' +
      'The contract ID, function name, and arguments are validated against strict schemas.',
  })
  @ApiBody({ type: SorobanInvocationDto })
  @ApiResponse({ status: 200, description: 'Contract invocation prepared successfully', type: SorobanResponseDto })
  @ApiResponse({ status: 400, description: 'Validation error - invalid contract ID, function name, or arguments' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 500, description: 'Stellar network error' })
  async invokeContract(
    @Body(new SorobanValidationPipe(sorobanInvocationSchema)) _body: SorobanInvocationDto,
  ): Promise<SorobanResponseDto> {
    // Placeholder - actual implementation would interact with Soroban client
    return {
      result: { status: 'success' },
      hash: 'mock-hash',
      feeCharged: 1000,
    };
  }

  @Post('soroban/submit')
  @ApiOperation({
    summary: 'Submit a Soroban transaction to the network',
    description:
      'Validates and submits a Soroban transaction envelope. ' +
      'The XDR envelope is validated for format and structure before submission.',
  })
  @ApiBody({ type: SorobanTransactionDto })
  @ApiResponse({ status: 200, description: 'Transaction submitted successfully', type: SorobanResponseDto })
  @ApiResponse({ status: 400, description: 'Validation error - invalid XDR format' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 500, description: 'Stellar network error' })
  async submitTransaction(
    @Body(new SorobanValidationPipe(sorobanTransactionSchema)) _body: SorobanTransactionDto,
  ): Promise<SorobanResponseDto> {
    // Placeholder - actual implementation would submit to Soroban network
    return {
      result: { status: 'success' },
      hash: 'mock-hash',
      feeCharged: 1000,
    };
  }
}
