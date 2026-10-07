import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { stellarMemoTypeSchema } from '../../common/validators/stellar-memo.schema';
import { stellarAddressSchema } from '../../common/validators/stellar-address.schema';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

const amountString = z
  .string()
  .regex(/^\d+(\.\d{1,7})?$/, 'Amount must be a positive decimal with up to 7 places')
  .refine((v) => Number(v) > 0, 'Amount must be greater than zero');

export const createTransactionSchema = z
  .object({
    walletId: z.string().uuid(),
    agentId: z.string().uuid().optional(),
    budgetId: z.string().uuid().optional(),
    asset: z.string().min(1).max(24).default('XLM'),
    amount: amountString,
    recipientAddress: stellarAddressSchema,
    memo: z.string().max(128).optional(),
    memoType: stellarMemoTypeSchema.optional(),
    memoValue: z.string().optional(),
    purpose: z.string().max(280).optional(),
    metadata: z.record(jsonValueSchema).default({}),
  })
  .strict()
  .superRefine((data, ctx) => {
    const hasTyped = data.memoType !== undefined;
    const hasLegacy = data.memo !== undefined;

    if (!hasTyped && !hasLegacy) return;

    if (hasTyped && !data.memoValue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'memoValue is required when memoType is specified',
        path: ['memoValue'],
      });
      return;
    }

    if (!hasTyped && hasLegacy) {
      const byteLength = new TextEncoder().encode(data.memo!).byteLength;
      if (byteLength === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Memo cannot be empty',
          path: ['memo'],
        });
      } else if (byteLength > 28) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Memo exceeds maximum length of 28 bytes (got ${byteLength} bytes)`,
          path: ['memo'],
        });
      }
      return;
    }

    if (hasTyped && data.memoValue !== undefined) {
      switch (data.memoType) {
        case 'text': {
          const byteLength = new TextEncoder().encode(data.memoValue).byteLength;
          if (byteLength === 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'Text memo cannot be empty',
              path: ['memoValue'],
            });
          } else if (byteLength > 28) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Text memo exceeds maximum length of 28 bytes (got ${byteLength} bytes)`,
              path: ['memoValue'],
            });
          }
          break;
        }
        case 'id': {
          if (!/^\d+$/.test(data.memoValue)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'Memo ID must be a non-negative integer string',
              path: ['memoValue'],
            });
          } else {
            try {
              const big = BigInt(data.memoValue);
              if (big < BigInt(0) || big > BigInt('18446744073709551615')) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: 'Memo ID must be in range 0 to 18446744073709551615',
                  path: ['memoValue'],
                });
              }
            } catch {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Memo ID is not a valid unsigned 64-bit integer',
                path: ['memoValue'],
              });
            }
          }
          break;
        }
        case 'hash':
        case 'return': {
          if (!/^[0-9a-fA-F]{64}$/.test(data.memoValue)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `${data.memoType === 'hash' ? 'Hash' : 'Return'} memo must be exactly 64 hex characters (32 bytes)`,
              path: ['memoValue'],
            });
          }
          break;
        }
      }
    }
  });

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;

export const simulateTransactionSchema = createTransactionSchema;
export type SimulateTransactionInput = z.infer<typeof simulateTransactionSchema>;

// ── Swagger DTOs ──

export class CreateTransactionDto {
  @ApiProperty({ description: 'Sender wallet id' })
  walletId!: string;

  @ApiPropertyOptional({ description: 'Initiating agent id' })
  agentId?: string;

  @ApiPropertyOptional({ description: 'Budget to charge this transaction against' })
  budgetId?: string;

  @ApiPropertyOptional({ example: 'XLM' })
  asset?: string;

  @ApiProperty({ example: '125.5000000' })
  amount!: string;

  @ApiProperty({ example: 'GB...' })
  recipientAddress!: string;

  @ApiPropertyOptional({
    description: 'Memo text (legacy format, max 28 bytes UTF-8)',
    maxLength: 28,
  })
  memo?: string;

  @ApiPropertyOptional({
    description: 'Stellar memo type: text, id, hash, or return',
    enum: ['text', 'id', 'hash', 'return'],
  })
  memoType?: 'text' | 'id' | 'hash' | 'return';

  @ApiPropertyOptional({
    description: 'Memo value for typed memos (required when memoType is specified)',
  })
  memoValue?: string;

  @ApiPropertyOptional()
  purpose?: string;

  @ApiPropertyOptional({ type: Object })
  metadata?: Record<string, unknown>;
}
