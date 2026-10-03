export interface AuditCursor {
  createdAt: Date;
  id: string;
}

interface EncodedAuditCursor {
  v: 1;
  createdAt: string;
  id: string;
}

export function encodeAuditCursor(cursor: AuditCursor): string {
  const value: EncodedAuditCursor = {
    v: 1,
    createdAt: cursor.createdAt.toISOString(),
    id: cursor.id,
  };
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeAuditCursor(value: string): AuditCursor {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(value)) {
    throw new Error('Invalid audit cursor');
  }

  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) throw new Error();
    const parsed = JSON.parse(decoded.toString('utf8')) as Partial<EncodedAuditCursor>;
    if (
      parsed.v !== 1 ||
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.id !== 'string' ||
      parsed.id.length < 1 ||
      parsed.id.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(parsed.id)
    ) {
      throw new Error();
    }

    const createdAt = new Date(parsed.createdAt);
    if (
      Number.isNaN(createdAt.getTime()) ||
      createdAt.toISOString() !== parsed.createdAt
    ) {
      throw new Error();
    }
    return { createdAt, id: parsed.id };
  } catch {
    throw new Error('Invalid audit cursor');
  }
}

export function isValidAuditCursor(value: string): boolean {
  try {
    decodeAuditCursor(value);
    return true;
  } catch {
    return false;
  }
}