/**
 * Sensitive field keys that must never appear in audit-logged payloads.
 * Scrubbed recursively from any object or nested structure.
 */
const SENSITIVE_FIELDS = new Set([
  'password',
  'passwordhash',
  'secret',
  'secretkey',
  'privatekey',
  'private_key',
  'refreshtoken',
  'refresh_token',
  'accesstoken',
  'access_token',
  'token',
  'apikey',
  'api_key',
  'hashedkey',
  'hashed_key',
  'webhooksecret',
  'webhook_secret',
  'hmacsecret',
  'hmac_secret',
  'x-api-key',
  'authorization',
  'signature',
  'clientsecret',
  'client_secret',
  'credentials',
]);

/** Sentinel value used to replace scrubbed secrets while preserving structure. */
export const REDACTED = '[REDACTED]';

/** True when `key` names a field whose value must never be logged or audited. */
export function isSensitiveField(key: string): boolean {
  return SENSITIVE_FIELDS.has(key.toLowerCase());
}

/**
 * Recursively removes sensitive fields from audit payloads, replacing values
 * with `[REDACTED]` so the surrounding structure is preserved without leaking
 * passwords, private keys, secrets, or tokens.
 *
 * Preserves the object/array shape and returns primitives untouched.
 */
export function sanitizeAuditPayload<T>(data: T): T {
  if (data === null || data === undefined) {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => sanitizeAuditPayload(item)) as unknown as T;
  }

  if (typeof data === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (isSensitiveField(key)) {
        sanitized[key] = REDACTED;
      } else {
        sanitized[key] = sanitizeAuditPayload(value);
      }
    }
    return sanitized as T;
  }

  return data;
}
