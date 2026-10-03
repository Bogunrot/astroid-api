import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import { ZodType } from 'zod';
import { ValidationException } from '../exceptions/domain.exception';
import { formatZodError } from '../validators/zod-error';

/**
 * Specialized validation pipe for Soroban transaction parameters.
 * Extends the generic ZodValidationPipe with Soroban-specific error handling
 * and enhanced validation for Stellar contract interactions.
 *
 * This pipe provides clearer error messages for common Soroban validation failures:
 * - Invalid contract ID format (not 64-char hex)
 * - Invalid function name format
 * - Invalid Stellar public key format
 * - Invalid XDR envelope format
 */
@Injectable()
export class SorobanValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const errorDetails = formatZodError(result.error);
      throw new ValidationException('Soroban transaction validation failed', errorDetails);
    }
    return result.data;
  }
}
