import { SetMetadata } from '@nestjs/common';

export const THROTTLE_TIER_KEY = 'astroid:throttleTier';

/**
 * The available rate-limit tiers:
 *   - `api`     — default for all authenticated API routes (THROTTLE_API_LIMIT/min)
 *   - `auth`    — sensitive credential / session routes (THROTTLE_AUTH_LIMIT/min)
 *   - `agent`   — high-frequency autonomous-agent routes (THROTTLE_AGENT_LIMIT/min)
 *   - `webhook` — outbound webhook management routes (THROTTLE_WEBHOOK_LIMIT/min)
 */
export type ThrottleTier = 'auth' | 'api' | 'agent' | 'webhook';

/**
 * Selects the rate-limit tier for a route.
 * Defaults to `api` when unset. Consumed by the AstroidThrottlerGuard.
 */
export const ThrottleTierDecorator = (tier: ThrottleTier) =>
  SetMetadata(THROTTLE_TIER_KEY, tier);
