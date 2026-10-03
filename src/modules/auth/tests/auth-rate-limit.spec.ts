import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';

import { AuthController } from '../auth.controller';
import { THROTTLE_TIER_KEY, ThrottleTier } from '../../../common/decorators/throttle-tier.decorator';

/**
 * Guards against a regression where `@ThrottleTierDecorator('auth')` is
 * silently dropped from a public auth route. The guard/config unit tests
 * cover enforcement in isolation, but nothing else asserts these specific
 * handlers actually opt into the stricter tier.
 */
describe('AuthController rate-limit wiring', () => {
  const reflector = new Reflector();

  it.each(['register', 'login', 'refresh'] as const)(
    'declares the auth throttle tier on %s',
    (method) => {
      const tier = reflector.get<ThrottleTier>(THROTTLE_TIER_KEY, AuthController.prototype[method]);

      expect(tier).toBe('auth');
    },
  );
});
