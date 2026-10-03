import { describe, it, expect } from 'vitest';
import { ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe, ZodValidationException } from './zod-validation.pipe';
import { ErrorCode } from '../constants/error-codes';

const metadata: ArgumentMetadata = { type: 'body', metatype: Object };

describe('ZodValidationPipe', () => {
  it('passes through valid input parsed by the schema', () => {
    const pipe = new ZodValidationPipe(z.object({ name: z.string() }));
    expect(pipe.transform({ name: 'alice' }, metadata)).toEqual({ name: 'alice' });
  });

  it('applies schema defaults and coercion', () => {
    const pipe = new ZodValidationPipe(
      z.object({ page: z.coerce.number().int().default(1) }),
    );
    expect(pipe.transform({}, metadata)).toEqual({ page: 1 });
  });

  it('strips unexpected properties from the parsed output', () => {
    const pipe = new ZodValidationPipe(z.object({ name: z.string() }));
    const parsed = pipe.transform({ name: 'alice', isAdmin: true }, metadata);
    expect(parsed).toEqual({ name: 'alice' });
    expect(parsed).not.toHaveProperty('isAdmin');
  });

  it('rejects unexpected properties when the schema is strict', () => {
    const pipe = new ZodValidationPipe(z.object({ name: z.string() }).strict());
    expect(() => pipe.transform({ name: 'alice', isAdmin: true }, metadata)).toThrow(
      ZodValidationException,
    );
  });

  describe('invalid payloads', () => {
    it('throws a ZodValidationException (a BadRequestException) on invalid input', () => {
      const pipe = new ZodValidationPipe(
        z.object({ email: z.string().email(), age: z.number().min(18) }),
      );

      try {
        pipe.transform({ email: 'not-an-email', age: 12 }, metadata);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ZodValidationException);
        expect(error).toBeInstanceOf(BadRequestException);

        const exception = error as ZodValidationException;
        expect(exception.getStatus()).toBe(400);
        expect(exception.code).toBe(ErrorCode.VALIDATION_ERROR);
        expect(exception.details).toEqual([
          { path: 'email', message: 'Invalid email' },
          { path: 'age', message: 'Number must be greater than or equal to 18' },
        ]);
      }
    });

    it('formats the exception response as the canonical error envelope body', () => {
      const pipe = new ZodValidationPipe(z.object({ email: z.string().email() }));

      try {
        pipe.transform({ email: 'nope' }, metadata);
        expect.fail('Should have thrown');
      } catch (error) {
        // The global exception filter reads this object to build
        // the problem details body `{ ..., code, detail, details, requestId }`.
        const response = (error as ZodValidationException).getResponse() as {
          code: string;
          message: string;
          details: Array<{ path: string; message: string }>;
        };
        expect(response.code).toBe(ErrorCode.VALIDATION_ERROR);
        expect(response.message).toBe('Request validation failed');
        expect(response.details).toEqual([{ path: 'email', message: 'Invalid email' }]);
      }
    });

    it('rejects a payload that is missing required fields', () => {
      const pipe = new ZodValidationPipe(
        z.object({ name: z.string(), email: z.string().email() }),
      );

      try {
        pipe.transform({}, metadata);
        expect.fail('Should have thrown');
      } catch (error) {
        const details = (error as ZodValidationException).details as Array<{
          path: string;
          message: string;
        }>;
        expect(details).toEqual([
          { path: 'name', message: 'Required' },
          { path: 'email', message: 'Required' },
        ]);
      }
    });

    it('rejects a malformed payload type before touching its fields', () => {
      const pipe = new ZodValidationPipe(z.object({ name: z.string() }));

      try {
        pipe.transform('not-an-object', metadata);
        expect.fail('Should have thrown');
      } catch (error) {
        const details = (error as ZodValidationException).details as Array<{
          path: string;
          message: string;
        }>;
        expect(details).toEqual([{ path: '', message: 'Expected object, received string' }]);
      }
    });
  });

  describe('nested object errors', () => {
    it('reports nested failures with dot-joined paths', () => {
      const pipe = new ZodValidationPipe(
        z.object({
          profile: z.object({ address: z.object({ city: z.string().min(1) }) }),
        }),
      );

      try {
        pipe.transform({ profile: { address: { city: '' } } }, metadata);
        expect.fail('Should have thrown');
      } catch (error) {
        const details = (error as ZodValidationException).details as Array<{
          path: string;
          message: string;
        }>;
        expect(details[0].path).toBe('profile.address.city');
        expect(details[0].message).toContain('at least 1 character');
      }
    });

    it('reports deep array element failures with index paths', () => {
      const pipe = new ZodValidationPipe(
        z.object({ recipients: z.array(z.string().min(1)) }),
      );

      try {
        pipe.transform({ recipients: ['GABC...', ''] }, metadata);
        expect.fail('Should have thrown');
      } catch (error) {
        const details = (error as ZodValidationException).details as Array<{
          path: string;
          message: string;
        }>;
        expect(details).toEqual([
          { path: 'recipients.1', message: 'String must contain at least 1 character(s)' },
        ]);
      }
    });
  });

  describe('custom message overrides', () => {
    it('supports custom error messages keyed by path', () => {
      const pipe = new ZodValidationPipe(
        z.object({ email: z.string().email() }),
        {
          customMessages: {
            email: 'Correo electrónico inválido',
          },
        },
      );

      try {
        pipe.transform({ email: 'bad' }, metadata);
        expect.fail('Should have thrown');
      } catch (error) {
        const details = (error as ZodValidationException).details as Array<{
          path: string;
          message: string;
        }>;
        expect(details).toEqual([
          { path: 'email', message: 'Correo electrónico inválido' },
        ]);
      }
    });

    it('supports a custom error mapping function for i18n', () => {
      const pipe = new ZodValidationPipe(
        z.object({ age: z.number().min(18) }),
        {
          errorMap: (err) =>
            err.issues.map((i) => ({
              path: i.path.join('.'),
              message: `Localized: ${i.message}`,
            })),
        },
      );

      try {
        pipe.transform({ age: 10 }, metadata);
        expect.fail('Should have thrown');
      } catch (error) {
        const details = (error as ZodValidationException).details as Array<{
          path: string;
          message: string;
        }>;
        expect(details[0].message).toContain('Localized:');
      }
    });
  });
});
