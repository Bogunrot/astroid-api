import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const assessRiskSchema = z.object({
  amount: z.number().positive(),
  asset: z.string().min(1).default('USDC'),
  knownRecipient: z.boolean().default(false),
  recentTransactionCount: z.number().int().nonnegative().default(0),
  walletAgeDays: z.number().int().nonnegative().default(0),
  policyViolations: z.number().int().nonnegative().default(0),
  hourUtc: z.number().int().min(0).max(23).optional(),
});

export type AssessRiskInput = z.infer<typeof assessRiskSchema>;

/** Swagger model mirroring {@link AssessRiskInput}. */
export class AssessRiskDto {
  @ApiProperty({ description: 'Transaction amount to assess', example: 100 })
  amount!: number;

  @ApiPropertyOptional({ description: 'Stellar asset code (defaults to USDC)', default: 'USDC', example: 'XLM' })
  asset?: string;

  @ApiPropertyOptional({ description: 'Whether the recipient is already known to the organization', default: false })
  knownRecipient?: boolean;

  @ApiPropertyOptional({ description: 'Transactions initiated by the agent recently', default: 0, example: 4 })
  recentTransactionCount?: number;

  @ApiPropertyOptional({ description: 'Age of the sending wallet in days', default: 0, example: 30 })
  walletAgeDays?: number;

  @ApiPropertyOptional({ description: 'Policy violations recorded for the agent', default: 0, example: 0 })
  policyViolations?: number;

  @ApiPropertyOptional({ description: 'Hour of the day in UTC (0-23); defaults to now when omitted', example: 14 })
  hourUtc?: number;
}
