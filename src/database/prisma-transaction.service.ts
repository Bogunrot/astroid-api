import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service';

/**
 * Per-invocation tuning for a transactional unit of work. Mirrors the subset of
 * `Prisma.TransactionClient` options this service exposes, plus a `name` used
 * for log correlation.
 */
export interface TransactionOptions {
  /**
   * Label used in the structured logs so an operator can attribute a slow or
   * failing transaction to the business flow that opened it (e.g.
   * `wallet.provision+initial-budget`).
   */
  name?: string;
  /** How long Prisma waits for a pooled connection before failing. */
  maxWait?: number;
  /** How long the whole transaction may run before Prisma aborts it. */
  timeout?: number;
  /**
   * Postgres isolation level. Omit to use the database default
   * (`READ COMMITTED`), which is correct for most flows.
   */
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

/** Prisma error codes that indicate a *retryable* transaction conflict. */
const RETRYABLE_TRANSACTION_CODES = new Set<string>(['P2034']);

/**
 * Options for {@link PrismaTransactionService.runWithRetry}. A serialization
 * failure (P2034) means the transaction lost a race under `Serializable` or
 * `Repeatable Read` isolation and is safe — indeed required — to replay.
 */
export interface TransactionRetryOptions extends TransactionOptions {
  /** Total number of attempts, including the first. Defaults to 3. */
  attempts?: number;
  /** Base delay for the exponential backoff, in ms. Defaults to 50. */
  backoffMs?: number;
}

/** Structured log record emitted for every transactional unit of work. */
export interface TransactionLogRecord {
  transaction: string;
  status: 'committed' | 'rolled_back';
  durationMs: number;
  attempt: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
  error?: string;
}

/**
 * Reusable transaction manager around `prisma.$transaction`.
 *
 * Services that need to touch several tables atomically — provisioning a wallet
 * *and* its opening budget, for example — call {@link run} with a callback and
 * receive a `Prisma.TransactionClient` bound to a single interactive
 * transaction:
 *
 * ```ts
 * const wallet = await this.transactions.run(async (tx) => {
 *   const created = await this.wallets.create(tx, input);
 *   await this.budgets.openInitialBudget(tx, created.id, amount);
 *   return created;
 * }, { name: 'wallet.provision+initial-budget' });
 * ```
 *
 * Why a wrapper instead of calling `prisma.$transaction` inline:
 *  - **Atomicity** — Prisma rolls the transaction back the moment the callback
 *    throws, so a failure half-way through a multi-step write can never leave
 *    the domain in a partially-applied state.
 *  - **No Prisma types in controllers** — the transactional client only ever
 *    exists as a callback argument, so it is structurally impossible to leak
 *    into a controller signature or a response payload.
 *  - **Observability** — every transaction emits one structured record with
 *    its name, outcome, duration and attempt count, which is what you need to
 *    answer "which business flow is slowly degrading write latency?".
 *  - **Correctness helpers** — {@link runWithRetry} replays serialization
 *    conflicts that Postgres tells us are safe to retry.
 *
 * The service is stateless and safe to inject anywhere; it holds no connection
 * of its own and delegates pooling to {@link PrismaService}.
 */
@Injectable()
export class PrismaTransactionService {
  private readonly logger = new Logger(PrismaTransactionService.name);

  /** Default wait for a pooled connection before giving up (ms). */
  static readonly DEFAULT_MAX_WAIT_MS = 5_000;
  /** Default ceiling on a single transaction's wall-clock duration (ms). */
  static readonly DEFAULT_TIMEOUT_MS = 10_000;
  /** Default number of attempts for {@link runWithRetry}. */
  static readonly DEFAULT_RETRY_ATTEMPTS = 3;
  /** Default exponential-backoff base delay (ms). */
  static readonly DEFAULT_RETRY_BACKOFF_MS = 50;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs `fn` inside a single interactive transaction and resolves with its
   * return value once the transaction commits.
   *
   * If `fn` throws — for any reason, including a non-`Error` value — Prisma
   * rolls the transaction back and the original error is rethrown unchanged so
   * callers keep the failure semantics they already handle elsewhere.
   */
  async run<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    const startedAt = Date.now();
    const record: TransactionLogRecord = {
      transaction: this.label(options),
      status: 'committed',
      durationMs: 0,
      attempt: 1,
      isolationLevel: options.isolationLevel,
    };

    try {
      const result = await this.prisma.$transaction(fn, {
        maxWait: options.maxWait ?? PrismaTransactionService.DEFAULT_MAX_WAIT_MS,
        timeout: options.timeout ?? PrismaTransactionService.DEFAULT_TIMEOUT_MS,
        isolationLevel: options.isolationLevel,
      });
      record.durationMs = Date.now() - startedAt;
      this.logger.debug(this.serialize(record));
      return result;
    } catch (error) {
      // The rollback itself is performed by Prisma before it rejects; rethrowing
      // the *original* error keeps the caller's error handling intact.
      record.status = 'rolled_back';
      record.durationMs = Date.now() - startedAt;
      record.error = this.describe(error);
      this.logger.error(this.serialize(record));
      throw error;
    }
  }

  /**
   * Same as {@link run} but at `SERIALIZABLE` isolation, where Postgres aborts
   * the transaction if its snapshot would conflict with a concurrent writer.
   * Pair with {@link runWithRetry} so the resulting P2034 is replayed.
   */
  runSerializable<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    return this.run(fn, { ...options, isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  /**
   * Runs a transactional unit of work, replaying it when Postgres reports a
   * serialization conflict (Prisma `P2034`). Any other error is surfaced
   * immediately without a replay.
   *
   * Only use this for operations that are safe to repeat — always re-read the
   * rows the callback mutates rather than reusing values from the failed
   * attempt, because a replay observes a newer snapshot.
   */
  async runWithRetry<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options: TransactionRetryOptions = {},
  ): Promise<T> {
    const maxAttempts = Math.max(1, options.attempts ?? PrismaTransactionService.DEFAULT_RETRY_ATTEMPTS);
    const backoffMs = options.backoffMs ?? PrismaTransactionService.DEFAULT_RETRY_BACKOFF_MS;

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.run(fn, options);
      } catch (error) {
        lastError = error;
        if (attempt === maxAttempts || !this.isRetryableConflict(error)) {
          throw error;
        }
        const delay = backoffMs * 2 ** (attempt - 1);
        this.logger.warn(
          this.serialize({
            transaction: this.label(options),
            status: 'rolled_back',
            durationMs: 0,
            attempt,
            isolationLevel: options.isolationLevel,
            error: this.describe(error),
          }) + ` retrying in ${delay}ms`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }

    // Unreachable: the loop either returns or throws on the final attempt.
    throw lastError;
  }

  /** True when the failure is a serialization/deadlock conflict worth replaying. */
  private isRetryableConflict(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && RETRYABLE_TRANSACTION_CODES.has(code);
  }

  private label(options: TransactionOptions): string {
    return options.name ?? 'anonymous';
  }

  private describe(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  private serialize(record: TransactionLogRecord): string {
    return JSON.stringify(record);
  }
}
