import { describe, it, expect } from 'vitest';
import { createTransactionSchema } from './transaction.dto';

describe('createTransactionSchema memo validation', () => {
  const baseInput = {
    walletId: '550e8400-e29b-41d4-a716-446655440000',
    amount: '10.0000000',
    recipientAddress: 'GDEGSXLGANKHK7QFOV63XCBHBTZ3YRKUJV7ZB7JMSJQB5CNBRLL5QIG5',
  };

  describe('payment input validation', () => {
    it('accepts a complete payment payload with metadata', () => {
      expect(
        createTransactionSchema.parse({
          ...baseInput,
          metadata: { invoiceId: 'invoice-1' },
        }),
      ).toMatchObject({
        amount: '10.0000000',
        recipientAddress: baseInput.recipientAddress,
        metadata: { invoiceId: 'invoice-1' },
      });
    });

    it('rejects missing wallet identifiers and negative or zero amounts', () => {
      expect(() =>
        createTransactionSchema.parse({
          amount: '10',
          recipientAddress: baseInput.recipientAddress,
        }),
      ).toThrow();
      expect(() =>
        createTransactionSchema.parse({ ...baseInput, amount: '-1' }),
      ).toThrow();
      expect(() =>
        createTransactionSchema.parse({ ...baseInput, amount: '0' }),
      ).toThrow();
    });

    it('rejects malformed recipients and non-object metadata', () => {
      expect(() =>
        createTransactionSchema.parse({ ...baseInput, recipientAddress: 'not-a-stellar-address' }),
      ).toThrow();
      expect(() =>
        createTransactionSchema.parse({ ...baseInput, metadata: ['unexpected'] }),
      ).toThrow();
    });

    it('rejects non-JSON values nested in metadata', () => {
      expect(() =>
        createTransactionSchema.parse({
          ...baseInput,
          metadata: { nested: { unsupported: undefined } },
        }),
      ).toThrow();
      expect(() =>
        createTransactionSchema.parse({
          ...baseInput,
          metadata: { nested: [Number.NaN] },
        }),
      ).toThrow();
    });
  });

  describe('legacy string memo (TEXT type)', () => {
    it('accepts valid legacy memo', () => {
      const result = createTransactionSchema.parse({ ...baseInput, memo: 'hello' });
      expect(result.memo).toBe('hello');
    });

    it('accepts 28-byte memo', () => {
      const result = createTransactionSchema.parse({ ...baseInput, memo: 'a'.repeat(28) });
      expect(result.memo).toBe('a'.repeat(28));
    });

    it('rejects 29-byte memo', () => {
      expect(() =>
        createTransactionSchema.parse({ ...baseInput, memo: 'a'.repeat(29) }),
      ).toThrow();
    });

    it('rejects empty string memo', () => {
      expect(() =>
        createTransactionSchema.parse({ ...baseInput, memo: '' }),
      ).toThrow();
    });

    it('accepts multibyte memo within byte limit', () => {
      const emoji = '\u{1F600}'; // 4 bytes
      const text = emoji.repeat(7); // 28 bytes
      const result = createTransactionSchema.parse({ ...baseInput, memo: text });
      expect(result.memo).toBe(text);
    });

    it('rejects multibyte memo exceeding byte limit', () => {
      const emoji = '\u{1F600}'; // 4 bytes
      const text = emoji.repeat(8); // 32 bytes
      expect(() =>
        createTransactionSchema.parse({ ...baseInput, memo: text }),
      ).toThrow();
    });
  });

  describe('typed memo (memoType + memoValue)', () => {
    it('accepts typed TEXT memo', () => {
      const result = createTransactionSchema.parse({
        ...baseInput,
        memoType: 'text',
        memoValue: 'hello',
      });
      expect(result.memoType).toBe('text');
      expect(result.memoValue).toBe('hello');
    });

    it('accepts typed ID memo', () => {
      const result = createTransactionSchema.parse({
        ...baseInput,
        memoType: 'id',
        memoValue: '12345',
      });
      expect(result.memoType).toBe('id');
      expect(result.memoValue).toBe('12345');
    });

    it('accepts typed HASH memo', () => {
      const hash = 'a'.repeat(64);
      const result = createTransactionSchema.parse({
        ...baseInput,
        memoType: 'hash',
        memoValue: hash,
      });
      expect(result.memoType).toBe('hash');
      expect(result.memoValue).toBe(hash);
    });

    it('accepts typed RETURN memo', () => {
      const hash = 'b'.repeat(64);
      const result = createTransactionSchema.parse({
        ...baseInput,
        memoType: 'return',
        memoValue: hash,
      });
      expect(result.memoType).toBe('return');
      expect(result.memoValue).toBe(hash);
    });

    it('rejects memoType without memoValue', () => {
      expect(() =>
        createTransactionSchema.parse({ ...baseInput, memoType: 'text' }),
      ).toThrow('memoValue is required');
    });

    it('rejects typed TEXT memo exceeding 28 bytes', () => {
      expect(() =>
        createTransactionSchema.parse({
          ...baseInput,
          memoType: 'text',
          memoValue: 'a'.repeat(29),
        }),
      ).toThrow();
    });

    it('rejects typed ID memo with negative value', () => {
      expect(() =>
        createTransactionSchema.parse({
          ...baseInput,
          memoType: 'id',
          memoValue: '-1',
        }),
      ).toThrow();
    });

    it('rejects typed ID memo exceeding uint64 max', () => {
      expect(() =>
        createTransactionSchema.parse({
          ...baseInput,
          memoType: 'id',
          memoValue: '18446744073709551616',
        }),
      ).toThrow();
    });

    it('rejects typed HASH memo that is too short', () => {
      expect(() =>
        createTransactionSchema.parse({
          ...baseInput,
          memoType: 'hash',
          memoValue: 'a'.repeat(63),
        }),
      ).toThrow();
    });

    it('rejects typed HASH memo with non-hex characters', () => {
      expect(() =>
        createTransactionSchema.parse({
          ...baseInput,
          memoType: 'hash',
          memoValue: 'g' + 'a'.repeat(63),
        }),
      ).toThrow();
    });

    it('rejects unknown memoType', () => {
      expect(() =>
        createTransactionSchema.parse({
          ...baseInput,
          memoType: 'unknown',
          memoValue: 'test',
        }),
      ).toThrow();
    });

    it('accepts typed memo alongside legacy memo field', () => {
      const result = createTransactionSchema.parse({
        ...baseInput,
        memo: 'legacy',
        memoType: 'hash',
        memoValue: 'a'.repeat(64),
      });
      expect(result.memo).toBe('legacy');
      expect(result.memoType).toBe('hash');
      expect(result.memoValue).toBe('a'.repeat(64));
    });
  });

  describe('no memo', () => {
    it('accepts transaction without any memo', () => {
      const result = createTransactionSchema.parse(baseInput);
      expect(result.memo).toBeUndefined();
      expect(result.memoType).toBeUndefined();
      expect(result.memoValue).toBeUndefined();
    });
  });

  describe('strict mode', () => {
    it('rejects unknown fields', () => {
      expect(() =>
        createTransactionSchema.parse({ ...baseInput, unknown: 'field' }),
      ).toThrow();
    });
  });
});
