import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Zod schema for Soroban contract invocation parameters.
 * Validates contract ID format, function name, and argument structure.
 */
export const sorobanInvocationSchema = z
  .object({
    contractId: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/, 'Contract ID must be a 64-character hex string'),
    functionName: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[a-zA-Z0-9_]+$/, 'Function name must contain only alphanumeric characters and underscores'),
    args: z.array(z.any()).default([]),
    feeLimit: z
      .number()
      .int()
      .positive()
      .max(100000000, 'Fee limit cannot exceed 100,000,000 stroops')
      .optional(),
    auth: z
      .object({
        sourceAccount: z.string().regex(/^G[A-Z0-9]{55}$/, 'Invalid Stellar public key').optional(),
        signature: z.string().optional(),
      })
      .optional(),
  })
  .strict();

export type SorobanInvocationInput = z.infer<typeof sorobanInvocationSchema>;

/**
 * Zod schema for Soroban transaction submission.
 * Validates the XDR envelope format and associated metadata.
 */
export const sorobanTransactionSchema = z
  .object({
    xdr: z
      .string()
      .min(1, 'XDR envelope is required')
      .regex(/^[A-Za-z0-9+/=]+$/, 'XDR must be valid base64'),
    network: z.enum(['TESTNET', 'PUBLIC', 'FUTURENET']).optional(),
    skipSimulation: z.boolean().optional(),
  })
  .strict();

export type SorobanTransactionInput = z.infer<typeof sorobanTransactionSchema>;

// ── Swagger DTOs (documentation only; validation is done by Zod pipes) ──

export class SorobanInvocationDto {
  @ApiProperty({
    description: 'Soroban contract ID (64-character hex string)',
    example: 'CDL3VCZ3R7J6HWAUKT4YJAQFJMXDZ25XSX2NZBY5LXYYZVP7KTCOHN7I',
  })
  contractId!: string;

  @ApiProperty({
    description: 'Contract function name to invoke',
    example: 'transfer',
  })
  functionName!: string;

  @ApiPropertyOptional({
    description: 'Function arguments (SCVal array)',
    type: [Object],
    example: [],
  })
  args?: unknown[];

  @ApiPropertyOptional({
    description: 'Maximum fee in stroops (1 stroop = 0.0000001 XLM)',
    example: 100000,
  })
  feeLimit?: number;

  @ApiPropertyOptional({
    description: 'Authentication parameters for the transaction',
    type: Object,
  })
  auth?: {
    sourceAccount?: string;
    signature?: string;
  };
}

export class SorobanTransactionDto {
  @ApiProperty({
    description: 'Base64-encoded Soroban transaction envelope XDR',
    example: 'AAAAAgAAA...',
  })
  xdr!: string;

  @ApiPropertyOptional({
    description: 'Stellar network to submit to',
    enum: ['TESTNET', 'PUBLIC', 'FUTURENET'],
  })
  network?: 'TESTNET' | 'PUBLIC' | 'FUTURENET';

  @ApiPropertyOptional({
    description: 'Skip transaction simulation (not recommended)',
  })
  skipSimulation?: boolean;
}

export class SorobanResponseDto {
  @ApiProperty({
    description: 'Transaction execution result',
    example: { status: 'success', returnValue: '...' },
  })
  result!: unknown;

  @ApiProperty({
    description: 'Transaction hash (if submitted)',
    example: 'a1b2c3d4...',
  })
  hash?: string;

  @ApiProperty({
    description: 'Fee charged in stroops',
    example: 5000,
  })
  feeCharged?: number;
}
