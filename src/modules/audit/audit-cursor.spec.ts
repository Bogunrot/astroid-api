import { describe, expect, it } from 'vitest';
import { decodeAuditCursor, encodeAuditCursor, isValidAuditCursor } from './audit-cursor';
import { auditListQuerySchema } from './audit-list.dto';

describe('audit cursor', () => {
  it('round-trips the stable timestamp and ID tuple', () => {
    const cursor = { createdAt: new Date('2026-09-29T12:30:00.000Z'), id: 'audit-123' };
    expect(decodeAuditCursor(encodeAuditCursor(cursor))).toEqual(cursor);
  });

  it.each(['', 'not-a-cursor', 'e30', Buffer.from('{"v":2}').toString('base64url')])(
    'rejects malformed cursor %s',
    (cursor) => {
      expect(isValidAuditCursor(cursor)).toBe(false);
      expect(auditListQuerySchema.safeParse({ cursor }).success).toBe(false);
    },
  );

  it('defaults to 20, bounds the page size, and rejects invalid time ranges', () => {
    expect(auditListQuerySchema.parse({}).limit).toBe(20);
    expect(auditListQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(auditListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(
      auditListQuerySchema.safeParse({
        from: '2026-09-30T00:00:00.000Z',
        to: '2026-09-01T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('accepts an inclusive range with equal boundaries and supported filters', () => {
    expect(
      auditListQuerySchema.safeParse({
        actorId: 'user-1',
        action: 'TRANSFER',
        resourceId: 'tx-1',
        from: '2026-09-29T12:00:00.000Z',
        to: '2026-09-29T12:00:00.000Z',
      }).success,
    ).toBe(true);
  });
});