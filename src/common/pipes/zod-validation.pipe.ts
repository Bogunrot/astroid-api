import {
  ArgumentMetadata,
  BadRequestException,
  Injectable,
  PipeTransform,
} from '@nestjs/common';
import { ZodType, ZodError } from 'zod';
import { ErrorCode } from '../constants/error-codes';
import { formatZodError, ValidationErrorDetail } from '../validators/zod-error';

export interface ZodValidationPipeOptions {
  errorMap?: (error: ZodError) => ValidationErrorDetail[];
  customMessages?: Record<string, string>;
  locale?: string;
}

/**
 * Thrown by {@link ZodValidationPipe} when a payload fails its Zod schema.
 *
 * Extends Nest's {@link BadRequestException} so the framework and the global
 * exception filter treat it as a standard client-side HTTP error, while also
 * carrying the canonical `VALIDATION_ERROR` code and structured `details` so
 * the problem details response keeps them as extension members:
 * `{ type, title, status: 400, detail, instance, code: 'VALIDATION_ERROR', details, requestId }`.
 */
export class ZodValidationException extends BadRequestException {
  /** Canonical domain error code preserved through the error envelope. */
  public readonly code = ErrorCode.VALIDATION_ERROR;

  /** Field-level validation problems in the shared detail shape. */
  public readonly details: ValidationErrorDetail[];

  constructor(message = 'Request validation failed', details: ValidationErrorDetail[] = []) {
    super({ code: ErrorCode.VALIDATION_ERROR, message, details }, message);
    this.details = details;
  }
}

/**
 * A pipe that validates and parses an incoming payload against a Zod schema.
 * Instantiated per-schema, e.g. `@Body(new ZodValidationPipe(createAgentSchema))`.
 * Rejects unknown/invalid data with a structured {@link ZodValidationException}
 * whose `details` use the canonical {@link formatZodError} shape, supporting
 * localized error message overrides.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(
    private readonly schema: ZodType<T>,
    private readonly options?: ZodValidationPipeOptions,
  ) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ZodValidationException(
        'Request validation failed',
        this.formatDetails(result.error),
      );
    }
    return result.data;
  }

  /**
   * Converts a Zod parse failure into the canonical detail list, honouring the
   * per-pipe overrides (custom error map, localized messages) when provided.
   */
  private formatDetails(error: ZodError): ValidationErrorDetail[] {
    if (this.options?.errorMap) {
      return this.options.errorMap(error);
    }

    const issues = error.issues.map((issue) => {
      const path = issue.path.join('.');
      const code = issue.code;
      let message = issue.message;
      if (this.options?.customMessages) {
        if (path && this.options.customMessages[`${path}.${code}`]) {
          message = this.options.customMessages[`${path}.${code}`];
        } else if (path && this.options.customMessages[path]) {
          message = this.options.customMessages[path];
        } else if (this.options.customMessages[code]) {
          message = this.options.customMessages[code];
        }
      }
      return { path, message };
    });

    if (issues.length > 0) {
      return issues;
    }
    return formatZodError(error);
  }
}
