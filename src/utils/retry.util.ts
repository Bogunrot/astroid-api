import { exponentialBackoffWithJitter } from './backoff.util';

export interface RetryOptions<E = unknown> {
  /** Total number of attempts (including the first). Default: 3. */
  maxAttempts?: number;
  /** Base delay in milliseconds for the first retry. Default: 500. */
  baseDelayMs?: number;
  /** Maximum delay cap in milliseconds. Default: 30_000. */
  maxDelayMs?: number;
  /**
   * Return true to allow a retry; false to stop immediately and rethrow.
   * When omitted, every error is retried up to `maxAttempts`.
   */
  isRetryable?: (error: E) => boolean;
  /**
   * Called just before each retry sleep so the caller can log or record
   * metrics without having to duplicate the retry logic.
   */
  onRetry?: (attempt: number, error: E, delayMs: number) => void;
  /** Human-readable label included in the final error message. */
  operationName?: string;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;

/**
 * Retries `fn` up to `maxAttempts` times with exponential backoff and
 * jitter.  The first invocation is attempt 1; only failures trigger a retry.
 *
 * @throws The error from the last attempt once all retries are exhausted.
 * @throws Immediately (without waiting for the next retry) when `isRetryable`
 *         returns `false`.
 */
export async function retryWithBackoff<T, E = unknown>(
  fn: () => Promise<T>,
  options: RetryOptions<E> = {},
): Promise<T> {
  const {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    isRetryable,
    onRetry,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (isRetryable && !isRetryable(error as E)) {
        throw error;
      }

      if (attempt === maxAttempts) {
        break;
      }

      const raw = exponentialBackoffWithJitter(attempt, baseDelayMs);
      const delayMs = Math.min(raw, maxDelayMs);

      onRetry?.(attempt, error as E, delayMs);

      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
