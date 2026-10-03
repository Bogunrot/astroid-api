import { SetMetadata } from '@nestjs/common';

export const SKIP_PUBLIC_RATE_LIMIT_KEY = 'astroid:skipPublicRateLimit';

/**
 * Exempts a public route (or controller) from the IP-based
 * `PublicRateLimitGuard`, e.g. an internal-only scrape endpoint that is
 * already restricted by network ACLs.
 */
export const SkipPublicRateLimit = () => SetMetadata(SKIP_PUBLIC_RATE_LIMIT_KEY, true);
