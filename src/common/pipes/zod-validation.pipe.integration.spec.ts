import { describe, expect, it } from 'vitest';
import { ZodValidationPipe, ZodValidationException } from './zod-validation.pipe';
import { z } from 'zod';

describe('ZodValidationPipe Integration', () => {
  describe('validation scenarios', () => {
    it('validates correct data against schema', () => {
      const schema = z.object({
        name: z.string().min(1),
        age: z.number().int().positive(),
      });

      const pipe = new ZodValidationPipe(schema);
      const result = pipe.transform({ name: 'John', age: 30 }, { type: 'body' });

      expect(result).toEqual({ name: 'John', age: 30 });
    });

    it('throws ZodValidationException for invalid data', () => {
      const schema = z.object({
        name: z.string().min(1),
        age: z.number().int().positive(),
      });

      const pipe = new ZodValidationPipe(schema);

      expect(() => pipe.transform({ name: '', age: -5 }, { type: 'body' })).toThrow(
        ZodValidationException,
      );
    });

    it('handles optional fields correctly', () => {
      const schema = z.object({
        name: z.string().min(1),
        age: z.number().int().positive().optional(),
      });

      const pipe = new ZodValidationPipe(schema);
      const result = pipe.transform({ name: 'John' }, { type: 'body' });

      expect(result).toEqual({ name: 'John', age: undefined });
    });

    it('handles nested objects', () => {
      const schema = z.object({
        user: z.object({
          name: z.string(),
          email: z.string().email(),
        }),
      });

      const pipe = new ZodValidationPipe(schema);
      const result = pipe.transform(
        { user: { name: 'John', email: 'john@example.com' } },
        { type: 'body' },
      );

      expect(result).toEqual({ user: { name: 'John', email: 'john@example.com' } });
    });

    it('handles arrays', () => {
      const schema = z.object({
        tags: z.array(z.string()).min(1),
      });

      const pipe = new ZodValidationPipe(schema);
      const result = pipe.transform({ tags: ['tag1', 'tag2'] }, { type: 'body' });

      expect(result).toEqual({ tags: ['tag1', 'tag2'] });
    });

    it('provides detailed error messages', () => {
      const schema = z.object({
        name: z.string().min(3),
        email: z.string().email(),
      });

      const pipe = new ZodValidationPipe(schema);

      try {
        pipe.transform({ name: 'Jo', email: 'invalid' }, { type: 'body' });
        expect.fail('Should have thrown ZodValidationException');
      } catch (error) {
        expect(error).toBeInstanceOf(ZodValidationException);
        const exception = error as ZodValidationException;
        expect(exception.details).toBeDefined();
        const details = exception.details as Array<{ path: string; message: string }>;
        expect(Array.isArray(details)).toBe(true);
        expect(details.length).toBeGreaterThan(0);
      }
    });

    it('supports custom error formatting', () => {
      const schema = z.object({
        name: z.string().min(1),
      });

      const customErrorMap = (error: z.ZodError) => {
        return error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: `Custom: ${issue.message}`,
        }));
      };

      const pipe = new ZodValidationPipe(schema, { errorMap: customErrorMap });

      try {
        pipe.transform({ name: '' }, { type: 'body' });
        expect.fail('Should have thrown ZodValidationException');
      } catch (error) {
        expect(error).toBeInstanceOf(ZodValidationException);
        const exception = error as ZodValidationException;
        const details = exception.details as Array<{ message: string }>;
        expect(details[0].message).toContain('Custom:');
      }
    });

    it('supports custom messages', () => {
      const schema = z.object({
        name: z.string().min(1),
      });

      const pipe = new ZodValidationPipe(schema, {
        customMessages: {
          name: 'Name is required',
        },
      });

      try {
        pipe.transform({ name: '' }, { type: 'body' });
        expect.fail('Should have thrown ZodValidationException');
      } catch (error) {
        expect(error).toBeInstanceOf(ZodValidationException);
        const exception = error as ZodValidationException;
        const details = exception.details as Array<{ message: string }>;
        expect(details[0].message).toBe('Name is required');
      }
    });
  });
});
