import { REDACTED, isSensitiveField } from '../common/helpers/audit-sanitizer';

/** Nesting depth past which values are replaced rather than walked. */
const MAX_DEPTH = 8;

/** Longest string kept verbatim in a log record before it is truncated. */
const MAX_STRING_LENGTH = 2_048;

/**
 * Secret-shaped substrings that can leak through free text (error messages,
 * stack traces, URLs) even when no field name gives them away.
 */
const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // Stellar secret seeds: 'S' followed by 55 base32 characters.
  [/\bS[A-Z2-7]{55}\b/g, REDACTED],
  // Bearer / Basic credentials in an Authorization-style header echo.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  // Userinfo embedded in a URL, e.g. postgres://user:pass@host.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
];

/** Masks secret-shaped substrings in free text and caps its length. */
export function scrubString(value: string): string {
  let scrubbed = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, replacement);
  }
  return scrubbed.length > MAX_STRING_LENGTH
    ? `${scrubbed.slice(0, MAX_STRING_LENGTH)}...[truncated]`
    : scrubbed;
}

/**
 * Produces a JSON-safe, secret-free copy of `value` for structured logging.
 *
 * Sensitive keys (see `isSensitiveField`) are replaced with `[REDACTED]`,
 * secret-shaped substrings inside strings are masked, and the result is always
 * serializable: cycles, bigints, functions, errors and over-deep nesting are
 * all coerced to plain values. The input is never mutated.
 */
export function scrubForLog(value: unknown): unknown {
  return scrub(value, 0, new WeakSet<object>());
}

function scrub(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;

  switch (typeof value) {
    case 'string':
      return scrubString(value);
    case 'number':
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'function':
    case 'symbol':
      return undefined;
  }

  const obj = value as object;
  if (seen.has(obj)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[MaxDepth]';

  if (obj instanceof Date) return obj.toISOString();
  if (obj instanceof Error) {
    return { name: obj.name, message: scrubString(obj.message) };
  }

  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return obj.map((item) => scrub(item, depth + 1, seen));
    }

    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(obj as Record<string, unknown>)) {
      out[key] = isSensitiveField(key) ? REDACTED : scrub(entry, depth + 1, seen);
    }
    return out;
  } finally {
    // Siblings may legitimately share a reference; only true ancestors are cycles.
    seen.delete(obj);
  }
}
