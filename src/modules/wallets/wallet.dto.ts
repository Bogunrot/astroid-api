import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StellarNetwork, WalletType, WalletStatus } from '@prisma/client';
import { stellarAddressSchema } from '../../common/validators/stellar-address.schema';

/**
 * Create a wallet. Two modes:
 *  - generate (default): the server mints a fresh Stellar keypair; the secret is
 *    returned to the caller EXACTLY ONCE and never stored (non-custodial).
 *  - import: the caller supplies an existing public `stellarAddress` to track.
 */
export const createWalletSchema = z
  .object({
    label: z.string().max(120).optional(),
    walletType: z.nativeEnum(WalletType).default(WalletType.AGENT),
    network: z.nativeEnum(StellarNetwork).default(StellarNetwork.TESTNET),
    agentId: z.string().uuid().optional(),
    /** When provided, the wallet is imported (address-only) rather than generated. */
    stellarAddress: stellarAddressSchema.optional(),
  })
  .strict();
export type CreateWalletInput = z.infer<typeof createWalletSchema>;

export const updateWalletSchema = z
  .object({
    label: z.string().max(120).optional(),
    agentId: z.string().uuid().nullable().optional(),
  })
  .strict();
export type UpdateWalletInput = z.infer<typeof updateWalletSchema>;

export const walletBalanceQuerySchema = z.object({}).strict();

// ── Swagger DTOs (documentation only; validation is done by Zod pipes) ──

export class CreateWalletDto {
  @ApiPropertyOptional({
    example: 'Treasury – Operations',
    description: 'Human-readable label for the wallet',
    maxLength: 120,
  })
  label?: string;

  @ApiPropertyOptional({
    enum: WalletType,
    description: 'Type of wallet (determines usage context)',
    enumName: 'WalletType',
  })
  walletType?: WalletType;

  @ApiPropertyOptional({
    enum: StellarNetwork,
    description: 'Stellar network the wallet operates on',
    enumName: 'StellarNetwork',
  })
  network?: StellarNetwork;

  @ApiPropertyOptional({
    description: 'UUID of the agent that owns this wallet (optional)',
    format: 'uuid',
  })
  agentId?: string;

  @ApiPropertyOptional({
    description: 'Import an existing Stellar address instead of generating a new keypair',
    example: 'GD5I3Q7IK...',
  })
  stellarAddress?: string;
}

export class UpdateWalletDto {
  @ApiPropertyOptional({
    description: 'Updated human-readable label for the wallet',
    maxLength: 120,
  })
  label?: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Reassign or clear the owning agent',
    format: 'uuid',
  })
  agentId?: string | null;
}

export class WalletSecretDto {
  @ApiProperty({
    description: 'Public Stellar address (G...)',
    example: 'GD5I3Q7IK...',
  })
  stellarAddress!: string;

  @ApiProperty({
    description:
      'The generated secret key (S...). Shown ONCE and never stored server-side. Persist it securely now.',
    example: 'SAB5...',
  })
  secretKey!: string;
}

export class WalletResponseDto {
  @ApiProperty({ description: 'Wallet UUID', format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'Organization UUID', format: 'uuid' })
  organizationId!: string;

  @ApiPropertyOptional({ description: 'Agent UUID if wallet is agent-owned', format: 'uuid' })
  agentId?: string;

  @ApiProperty({ description: 'Stellar public address', example: 'GD5I3Q7IK...' })
  stellarAddress!: string;

  @ApiPropertyOptional({ description: 'Human-readable label' })
  label?: string;

  @ApiProperty({ enum: WalletType, description: 'Wallet type' })
  walletType!: WalletType;

  @ApiProperty({ enum: StellarNetwork, description: 'Stellar network' })
  network!: StellarNetwork;

  @ApiProperty({ enum: WalletStatus, description: 'Current wallet status' })
  status!: WalletStatus;

  @ApiProperty({ description: 'Wallet creation timestamp' })
  createdAt!: Date;

  @ApiProperty({ description: 'Last update timestamp' })
  updatedAt!: Date;
}

export class WalletBalanceDto {
  @ApiProperty({ description: 'Asset code (e.g., XLM, USDC)', example: 'XLM' })
  asset!: string;

  @ApiProperty({ description: 'Balance amount', example: '100.0000000' })
  balance!: string;

  @ApiPropertyOptional({ description: 'Asset issuer address (null for native XLM)' })
  issuer?: string;
}
