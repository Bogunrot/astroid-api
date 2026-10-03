/**
 * Sanitizes a free-text field value for storage and comparison.
 *
 * Collapses interior runs of whitespace (spaces, tabs, newlines) to a single
 * space and strips leading/trailing whitespace. This prevents payload bloat,
 * accidental duplicate records that differ only by whitespace, and search
 * misses caused by extraneous padding.
 */
export function sanitizeTextField(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
