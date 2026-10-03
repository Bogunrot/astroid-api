import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { argon2id, hash, verify } from 'argon2';

/**
 * Cryptographic helpers used for API keys, webhook signatures and refresh
 * tokens. Secrets are never stored in plaintext — only Argon2id hashes for
 * API keys (with SHA-256 fallback for legacy keys) and SHA-256 for other
 * non-reversible hashes.
 */

/** Generates a random URL-safe token of `bytes` entropy (hex-encoded). */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/** SHA-256 hex digest of a value — used for non-reversible key hashes (e.g., refresh tokens). */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Argon2id hash of a value — used for API keys for enhanced security.
 * Argon2id is memory-hard and resistant to GPU/ASIC attacks.
 * 
 * @param value - The plaintext value to hash
 * @returns The Argon2id hash string
 */
export async function hashWithArgon2(value: string): Promise<string> {
  return await hash(value, {
    type: argon2id,
    memoryCost: 65536, // 64 MB
    timeCost: 3, // 3 iterations
    parallelism: 4, // 4 threads
    hashLength: 32,
  });
}

/**
 * Verifies a value against an Argon2id hash.
 * Uses constant-time comparison to prevent timing attacks.
 * 
 * @param hash - The stored Argon2id hash
 * @param value - The plaintext value to verify
 * @returns true if the value matches the hash, false otherwise
 */
export async function verifyArgon2(hash: string, value: string): Promise<boolean> {
  try {
    return await verify(hash, value);
  } catch {
    return false;
  }
}

/** Computes an HMAC-SHA256 signature (hex) for webhook payload signing. */
export function hmacSign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Generates a webhook HMAC-SHA256 signature per the Astroid spec.
 * The signing payload is `timestamp + JSON-serialized body` (concatenated
 * without delimiter) hashed with the tenant's webhook secret.
 * A dot-delimited variant (`timestamp.body`) is also accepted by the
 * verification guard; this helper uses the plain concatenation form to
 * match the documented requirement.
 */
export function generateWebhookSignature(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}${body}`).digest('hex');
}

/**
 * Builds the standard set of webhook delivery headers.
 * Includes X-Astroid-Signature, X-Astroid-Delivery, X-Astroid-Event and
 * X-Astroid-Timestamp (plus X-Astroid-Event-Id for backward compatibility).
 */
export function buildWebhookHeaders(params: {
  signature: string;
  timestamp: string;
  deliveryId: string;
  eventName: string;
}): Record<string, string> {
  return {
    'x-astroid-signature': params.signature,
    'x-astroid-timestamp': params.timestamp,
    'x-astroid-delivery': params.deliveryId,
    'x-astroid-event': params.eventName,
    'x-astroid-event-id': params.deliveryId,
  };
}

/** Constant-time comparison of two signatures to prevent timing attacks. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export interface GeneratedApiKey {
  /** The full secret shown to the user exactly once. */
  raw: string;
  /** The short prefix stored for identification (e.g. `ak_live_abcd`). */
  prefix: string;
  /** The Argon2id hash persisted in the database. */
  hashedKey: string;
}

/**
 * Mints a new API key: `ak_<env>_<random>`, returning raw + prefix + Argon2id hash.
 * Uses Argon2id for enhanced security against brute-force and GPU attacks.
 */
export async function generateApiKey(environment = 'live'): Promise<GeneratedApiKey> {
  const secret = generateToken(24);
  const raw = `ak_${environment}_${secret}`;
  const prefix = raw.slice(0, 14);
  const hashedKey = await hashWithArgon2(raw);
  return { raw, prefix, hashedKey };
}
