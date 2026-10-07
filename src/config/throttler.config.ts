import { registerAs } from '@nestjs/config';
import { ThrottlerModuleOptions, ThrottlerOptions, ThrottlerStorage } from '@nestjs/throttler';
import { throttleEnvSchema, validateEnv } from './env.validation';

/**
 * The object form of {@link ThrottlerModuleOptions} — the only form that can
 * carry a `storage` implementation.
 */
export type TieredThrottlerOptions = Exclude<ThrottlerModuleOptions, ThrottlerOptions[]>;

export type ThrottlerConfig = {
  /** Fixed-window length in seconds, shared by every steady-state tier. */
  windowSeconds: number;
  /** Requests allowed per window on the public `api` tier. */
  apiLimit: number;
  /** Requests allowed per window on the sensitive `auth` tier. */
  authLimit: number;
  /** Requests allowed per window for a single autonomous agent. */
  agentLimit: number;
  /** Requests allowed per window on the `webhook` management tier. */
  webhookLimit: number;
  /**
   * Burst throttlers — each applies a 1-second window with a per-tier
   * maximum so single-second spikes don't consume the full steady-state quota.
   * A value of 0 disables burst enforcement for that tier.
   */
  apiBurst: number;
  authBurst: number;
  webhookBurst: number;
};

/**
 * Rate-limit configuration, driven by the `THROTTLE_*` environment variables.
 *
 * The dedicated `throttler` namespace makes the ownership of these variables
 * explicit (they previously lived ambiguously under `queue`).
 */
export const throttlerConfig = registerAs('throttler', (): ThrottlerConfig => {
  const env = validateEnv(throttleEnvSchema, process.env);
  return {
    windowSeconds: env.THROTTLE_TTL,
    apiLimit: env.THROTTLE_API_LIMIT,
    authLimit: env.THROTTLE_AUTH_LIMIT,
    agentLimit: env.THROTTLE_AGENT_LIMIT,
    webhookLimit: env.THROTTLE_WEBHOOK_LIMIT,
    apiBurst: env.THROTTLE_API_BURST,
    authBurst: env.THROTTLE_AUTH_BURST,
    webhookBurst: env.THROTTLE_WEBHOOK_BURST,
  };
});

/**
 * Builds the named throttlers consumed by `AstroidThrottlerGuard`:
 *
 *  Steady-state tiers (TTL = `windowSeconds`):
 *   - `api`     — every route that does not declare a tier explicitly
 *   - `auth`    — routes marked with `@ThrottleTierDecorator('auth')`
 *   - `agent`   — high-frequency routes enforced by `AgentThrottlerGuard`
 *   - `webhook` — routes marked with `@ThrottleTierDecorator('webhook')`
 *
 *  Burst tiers (TTL = 1 second), only registered when the burst limit > 0:
 *   - `api-burst`     — short-term spike guard for `api` routes
 *   - `auth-burst`    — short-term spike guard for `auth` routes
 *   - `webhook-burst` — short-term spike guard for `webhook` routes
 *
 * The options must be returned in the object form (not the bare array) so the
 * shared Redis {@link ThrottlerStorage} can be attached: `@nestjs/throttler`
 * only honours `storage` when the options are an object.
 *
 * `blockDuration` is intentionally left unset so it defaults to the window
 * `ttl` — a client that exhausts its quota waits out one full window.
 */
export function createThrottlerOptions(
  config: ThrottlerConfig,
  storage?: ThrottlerStorage,
): TieredThrottlerOptions {
  const ttl = config.windowSeconds * 1000;
  const burstTtl = 1_000; // 1 second burst window

  const throttlers: ThrottlerOptions[] = [
    // ── Steady-state tiers ──────────────────────────────────────────────────
    { name: 'api', ttl, limit: config.apiLimit },
    { name: 'auth', ttl, limit: config.authLimit },
    { name: 'agent', ttl, limit: config.agentLimit },
    { name: 'webhook', ttl, limit: config.webhookLimit },
  ];

  // ── Burst tiers — only wired when burst > 0 ─────────────────────────────
  if (config.apiBurst > 0) {
    throttlers.push({ name: 'api-burst', ttl: burstTtl, limit: config.apiBurst });
  }
  if (config.authBurst > 0) {
    throttlers.push({ name: 'auth-burst', ttl: burstTtl, limit: config.authBurst });
  }
  if (config.webhookBurst > 0) {
    throttlers.push({ name: 'webhook-burst', ttl: burstTtl, limit: config.webhookBurst });
  }

  return {
    ...(storage ? { storage } : {}),
    throttlers,
  };
}
