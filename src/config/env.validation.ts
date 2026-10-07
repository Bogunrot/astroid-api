import { z } from 'zod';

/**
 * Base Zod schemas for every configuration slice. Each config factory validates
 * `process.env` on startup and throws a descriptive error if invalid — the app
 * must never boot with an invalid configuration.
 */

export const appEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_NAME: z.string().default('astroid-api'),
  PORT: z.coerce.number().int().positive().default(3000),
  API_PREFIX: z.string().default('api/v1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: z.string().default('*'),
});

export const databaseEnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // Connection pool sizing — applied as Prisma `connection_limit` URL params.
  DATABASE_CONNECTION_LIMIT: z.coerce.number().int().positive().default(10),
  // Worker pool stays small: background jobs must never starve API traffic.
  DATABASE_WORKER_CONNECTION_LIMIT: z.coerce.number().int().positive().default(3),
  // How long a query waits for a free connection before failing fast (ms).
  // 0 waits indefinitely (Prisma `pool_timeout` semantics).
  DATABASE_POOL_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(5000),
  // Client-side guard: fails the promise fast when a query exceeds this (ms).
  // 0 disables the client-side race (server-side statement_timeout still applies).
  DATABASE_QUERY_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(5000),
  // Server-side `statement_timeout` (ms) — Postgres aborts the runaway query so
  // the pooled connection is actually released. 0 disables the guard.
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(10000),
  // Extended client-side timeout for the dedicated worker pool (ms). Long-running
  // worker transactions (rollups, outbox drains) must not be killed by the API
  // guard; 0 disables the worker guard entirely.
  DATABASE_WORKER_QUERY_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(60000),
  // Boot-time migration status check: `strict` aborts startup on pending or
  // failed migrations, `warn` only logs, `off` skips it. When unset, production
  // is strict and every other environment warns.
  DATABASE_MIGRATION_CHECK: z.enum(['strict', 'warn', 'off']).optional(),
  // Location of the Prisma migrations folder the check compares against.
  // Defaults to `<cwd>/prisma/migrations`.
  DATABASE_MIGRATIONS_DIR: z.string().min(1).optional(),
  // Slow query logging threshold (ms). Queries exceeding this emit a warn log.
  // 0 disables slow query logging.
  DATABASE_SLOW_QUERY_THRESHOLD_MS: z.coerce.number().int().nonnegative().default(1000),
  DATABASE_CONNECT_RETRY_ATTEMPTS: z.coerce.number().int().positive().max(10).default(5),
  DATABASE_CONNECT_RETRY_DELAY_MS: z.coerce.number().int().positive().max(60000).default(1000),
  DATABASE_MIGRATION_CHECK_ENABLED: z.coerce.boolean().default(true),
  DATABASE_MIGRATION_CHECK_MODE: z.enum(['halt', 'warn']).default('halt'),
});

export const redisEnvSchema = z.object({
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional().default(''),
  REDIS_DB: z.coerce.number().int().nonnegative().default(0),
});

export const authEnvSchema = z.object({
  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be >= 16 chars'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be >= 16 chars'),
  JWT_ACCESS_TTL: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL: z.coerce.number().int().positive().default(1209600),
  PASSKEY_RP_ID: z.string().default('localhost'),
  PASSKEY_RP_NAME: z.string().default('Astroid'),
  PASSKEY_ORIGIN: z.string().default('http://localhost:3001'),
});

export const stellarEnvSchema = z.object({
  STELLAR_NETWORK: z.enum(['testnet', 'public', 'futurenet']).default('testnet'),
  STELLAR_HORIZON_URL: z.string().default('https://horizon-testnet.stellar.org'),
  STELLAR_SOROBAN_RPC_URL: z.string().default('https://soroban-testnet.stellar.org'),
  STELLAR_REGISTRY_CONTRACT_ID: z.string().optional().default(''),
  STELLAR_USE_MOCK: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

export const storageEnvSchema = z.object({
  STORAGE_ENDPOINT: z.string().default('http://localhost:9000'),
  STORAGE_REGION: z.string().default('us-east-1'),
  STORAGE_BUCKET: z.string().default('astroid'),
  STORAGE_ACCESS_KEY: z.string().default('astroid'),
  STORAGE_SECRET_KEY: z.string().default('astroid-secret'),
});

export const queueEnvSchema = z.object({
  QUEUE_PREFIX: z.string().default('astroid'),
  QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(5),
});

export const throttleEnvSchema = z.object({
  THROTTLE_AUTH_LIMIT: z.coerce.number().int().positive().default(10),
  THROTTLE_API_LIMIT: z.coerce.number().int().positive().default(120),
  /** Requests allowed per window for traffic identified as an autonomous agent. */
  THROTTLE_AGENT_LIMIT: z.coerce.number().int().positive().default(300),
  THROTTLE_WEBHOOK_LIMIT: z.coerce.number().int().positive().default(30),
  THROTTLE_TTL: z.coerce.number().int().positive().default(60),
  // Short-term burst allowance per tier (requests per second). A burst window
  // is intentionally kept very short (1 s) so spikes don't exhaust the full
  // steady-state quota. Set to 0 to disable burst enforcement.
  THROTTLE_API_BURST: z.coerce.number().int().nonnegative().default(10),
  THROTTLE_AUTH_BURST: z.coerce.number().int().nonnegative().default(3),
  THROTTLE_WEBHOOK_BURST: z.coerce.number().int().nonnegative().default(5),
});

export const rateLimitEnvSchema = z.object({
  // Sliding-window size, in seconds, for the Redis-backed rate limiter guard.
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  // Max requests allowed per client within the sliding window.
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(120),
  // IP-based limiter for unauthenticated routes (@Public() or under
  // `<API_PREFIX>/public/`), shared across replicas via Redis.
  PUBLIC_RATE_LIMIT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  PUBLIC_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(60),
  PUBLIC_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  // Only enable behind a trusted reverse proxy: the client IP is then read from
  // the first X-Forwarded-For entry, which clients can otherwise spoof.
  PUBLIC_RATE_LIMIT_TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export const metricsEnvSchema = z.object({
  // Comma-separated CIDR ranges permitted to scrape /metrics. Defaults to
  // loopback + RFC1918 private ranges so the endpoint is internal-only unless
  // explicitly opened up (e.g. for a Prometheus server outside the VPC).
  METRICS_ALLOWED_IPS: z
    .string()
    .default('127.0.0.1/32,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16'),
});

export const shutdownEnvSchema = z.object({
  // How long in-flight HTTP requests and BullMQ jobs may run after SIGTERM /
  // SIGINT before they are forcibly terminated (ms). Keep this plus ~10s of
  // resource-close headroom below the orchestrator's kill deadline (Kubernetes
  // terminationGracePeriodSeconds defaults to 30s).
  SHUTDOWN_GRACE_PERIOD_MS: z.coerce.number().int().positive().default(20_000),
});

export const aiEnvSchema = z.object({
  AI_PROVIDER: z.string().default('nvidia'),
  AI_PROVIDER_KEY: z.string().min(1, 'AI_PROVIDER_KEY is required'),
  AI_BASE_URL: z.string().default('https://integrate.api.nvidia.com/v1'),
  AI_MODEL: z.string().default('meta/llama-3.1-70b-instruct'),
});

/**
 * Publicly known development default for `ENCRYPTION_KEY`. Convenient locally,
 * but anything encrypted with it is readable by anyone with the source code, so
 * {@link environmentSchema} rejects it in production.
 */
export const INSECURE_DEFAULT_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

export const encryptionEnvSchema = z.object({
  ENCRYPTION_KEY: z
    .string()
    .default(INSECURE_DEFAULT_ENCRYPTION_KEY)
    .refine(
      (key) => {
        if (!key) return false;
        if (/^[0-9a-fA-F]{64}$/.test(key)) return true;
        if (Buffer.byteLength(key, 'utf8') === 32) return true;
        try {
          const buf = Buffer.from(key, 'base64');
          if (buf.length === 32) return true;
        } catch {
          return false;
        }
        return false;
      },
      { message: 'ENCRYPTION_KEY must be a 32-byte (256-bit) key (64 hex characters or 32 bytes)' },
    ),
  ENCRYPTION_ALGORITHM: z.string().default('aes-256-gcm'),
});

/**
 * The complete configuration contract: every environment variable the API reads,
 * composed from the per-slice schemas above so there is a single source of truth.
 * Validated once at boot by {@link assertValidEnvironment}, before any module is
 * constructed, so every problem is reported together instead of one slice at a
 * time from deep inside Nest's module initialization.
 *
 * Production additionally rejects insecure-but-valid values that are fine for
 * local development.
 */
export const environmentSchema = z
  .object({
    ...appEnvSchema.shape,
    ...databaseEnvSchema.shape,
    ...redisEnvSchema.shape,
    ...authEnvSchema.shape,
    ...stellarEnvSchema.shape,
    ...storageEnvSchema.shape,
    ...queueEnvSchema.shape,
    ...throttleEnvSchema.shape,
    ...rateLimitEnvSchema.shape,
    ...metricsEnvSchema.shape,
    ...aiEnvSchema.shape,
    ...encryptionEnvSchema.shape,
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') {
      return;
    }

    if (env.ENCRYPTION_KEY === INSECURE_DEFAULT_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ENCRYPTION_KEY'],
        message:
          'must be set to a unique secret in production; the built-in development default is publicly known',
      });
    }

    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message: 'must differ from JWT_ACCESS_SECRET in production',
      });
    }
  });

export type Environment = z.infer<typeof environmentSchema>;

/** A single failing configuration key, safe to log (never contains the value). */
export interface EnvironmentIssue {
  key: string;
  message: string;
}

/**
 * Thrown when the environment does not satisfy {@link environmentSchema}. The
 * message lists every failing variable so an operator can fix them all in one
 * pass; it never includes the offending values, which may be secrets.
 */
export class EnvironmentValidationError extends Error {
  constructor(readonly issues: EnvironmentIssue[]) {
    super(
      [
        `Invalid environment configuration (${issues.length} problem${issues.length === 1 ? '' : 's'}):`,
        ...issues.map((issue) => `  - ${issue.key}: ${issue.message}`),
        'Fix the variables above (see .env.example and docs/configuration.md) and restart.',
      ].join('\n'),
    );
    this.name = 'EnvironmentValidationError';
  }
}

/**
 * Converts a Zod issue into a value-free message. Zod's defaults can echo the
 * received value (e.g. for enums), which must never reach logs for secrets.
 */
function describeIssue(issue: z.ZodIssue): string {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      return issue.received === 'undefined'
        ? 'is required but was not set'
        : `must be a valid ${issue.expected}`;
    case z.ZodIssueCode.invalid_enum_value:
      return `must be one of: ${issue.options.join(', ')}`;
    default:
      return issue.message;
  }
}

/**
 * Validates the full process environment against {@link environmentSchema} and
 * returns the parsed configuration (defaults applied, transforms resolved).
 *
 * @throws EnvironmentValidationError listing every failing variable.
 */
export function assertValidEnvironment(env: NodeJS.ProcessEnv): Environment {
  const result = environmentSchema.safeParse(env);
  if (!result.success) {
    throw new EnvironmentValidationError(
      result.error.issues.map((issue) => ({
        key: issue.path.join('.') || '(root)',
        message: describeIssue(issue),
      })),
    );
  }
  return result.data;
}

/**
 * Validates a slice of the environment against a schema, throwing a readable
 * error that lists every failing variable. Returns the schema's OUTPUT type
 * (defaults applied, transforms resolved).
 */
export function validateEnv<T extends z.ZodTypeAny>(schema: T, env: NodeJS.ProcessEnv): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
