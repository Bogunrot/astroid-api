import { describe, expect, it } from 'vitest';
import { scrubForLog, scrubString } from './log-scrubber.util';

const STELLAR_SEED = 'SCZANGBA5YHTNYVVV4C3U252E2B6P6F5T3U6MM63WBSBZATAQI3EBTQ4';

describe('scrubString', () => {
  it('masks Stellar secret seeds', () => {
    expect(scrubString(`bad seed ${STELLAR_SEED} rejected`)).toBe('bad seed [REDACTED] rejected');
  });

  it('masks bearer and basic credentials', () => {
    expect(scrubString('Authorization: Bearer eyJhbGciOi.abc.def')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
    expect(scrubString('basic dXNlcjpwYXNz')).toBe('basic [REDACTED]');
  });

  it('masks userinfo embedded in URLs', () => {
    expect(scrubString('connect postgres://admin:hunter2@db:5432/app failed')).toBe(
      'connect postgres://[REDACTED]@db:5432/app failed',
    );
  });

  it('leaves ordinary text and public keys untouched', () => {
    const text = 'wallet GABC123 synced in 12ms';
    expect(scrubString(text)).toBe(text);
  });

  it('truncates very long strings', () => {
    const out = scrubString('x'.repeat(5_000));
    expect(out.endsWith('...[truncated]')).toBe(true);
    expect(out.length).toBeLessThan(2_100);
  });
});

describe('scrubForLog', () => {
  it('redacts sensitive keys at any depth without mutating the input', () => {
    const input = {
      webhookId: 'wh-1',
      secret: 'whsec_live',
      nested: { apiKey: 'ak_1', list: [{ password: 'p' }, { ok: true }] },
    };

    expect(scrubForLog(input)).toEqual({
      webhookId: 'wh-1',
      secret: '[REDACTED]',
      nested: { apiKey: '[REDACTED]', list: [{ password: '[REDACTED]' }, { ok: true }] },
    });
    expect(input.secret).toBe('whsec_live');
  });

  it('masks secret-shaped values under innocuous keys', () => {
    expect(scrubForLog({ memo: STELLAR_SEED })).toEqual({ memo: '[REDACTED]' });
  });

  it('coerces non-JSON values into serializable ones', () => {
    const when = new Date('2026-01-01T00:00:00.000Z');
    const out = scrubForLog({
      amount: 10n,
      when,
      fn: () => 1,
      err: new Error(`seed ${STELLAR_SEED}`),
    });

    expect(out).toEqual({
      amount: '10',
      when: '2026-01-01T00:00:00.000Z',
      fn: undefined,
      err: { name: 'Error', message: 'seed [REDACTED]' },
    });
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it('breaks cycles but keeps shared sibling references', () => {
    const shared = { id: 's' };
    const cyclic: Record<string, unknown> = { a: shared, b: shared };
    cyclic.self = cyclic;

    expect(scrubForLog(cyclic)).toEqual({ a: { id: 's' }, b: { id: 's' }, self: '[Circular]' });
  });

  it('stops walking past the depth limit', () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 12; i++) deep = { child: deep };

    expect(JSON.stringify(scrubForLog(deep))).toContain('[MaxDepth]');
  });

  it('passes primitives and nullish values through', () => {
    expect(scrubForLog(null)).toBeNull();
    expect(scrubForLog(undefined)).toBeUndefined();
    expect(scrubForLog(42)).toBe(42);
    expect(scrubForLog(false)).toBe(false);
  });
});
