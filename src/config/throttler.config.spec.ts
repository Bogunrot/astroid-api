import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThrottlerStorage } from '@nestjs/throttler';

import { createThrottlerOptions, throttlerConfig, ThrottlerConfig } from './throttler.config';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('throttlerConfig', () => {
  it('falls back to the documented defaults when no THROTTLE_* variable is set', () => {
    delete process.env.THROTTLE_TTL;
    delete process.env.THROTTLE_API_LIMIT;
    delete process.env.THROTTLE_AUTH_LIMIT;
    delete process.env.THROTTLE_AGENT_LIMIT;
    delete process.env.THROTTLE_WEBHOOK_LIMIT;

    expect(throttlerConfig() as ThrottlerConfig).toEqual({
      windowSeconds: 60,
      apiLimit: 120,
      authLimit: 10,
      agentLimit: 300,
      webhookLimit: 30,
      apiBurst: 10,
      authBurst: 3,
      webhookBurst: 5,
    });
  });

  it('reads overrides from the THROTTLE_* environment variables', () => {
    process.env.THROTTLE_TTL = '30';
    process.env.THROTTLE_API_LIMIT = '500';
    process.env.THROTTLE_AUTH_LIMIT = '5';
    process.env.THROTTLE_AGENT_LIMIT = '900';
    process.env.THROTTLE_WEBHOOK_LIMIT = '60';
    process.env.THROTTLE_API_BURST = '20';
    process.env.THROTTLE_AUTH_BURST = '2';
    process.env.THROTTLE_WEBHOOK_BURST = '8';

    expect(throttlerConfig() as ThrottlerConfig).toEqual({
      windowSeconds: 30,
      apiLimit: 500,
      authLimit: 5,
      agentLimit: 900,
      webhookLimit: 60,
      apiBurst: 20,
      authBurst: 2,
      webhookBurst: 8,
    });
  });

  it('rejects a non-numeric THROTTLE_TTL instead of booting with a broken limit', () => {
    process.env.THROTTLE_TTL = 'not-a-number';

    expect(() => throttlerConfig()).toThrow(/THROTTLE_TTL/);
  });

  it('accepts zero burst values to disable burst enforcement', () => {
    process.env.THROTTLE_API_BURST = '0';
    process.env.THROTTLE_AUTH_BURST = '0';
    process.env.THROTTLE_WEBHOOK_BURST = '0';

    const config = throttlerConfig() as ThrottlerConfig;

    expect(config.apiBurst).toBe(0);
    expect(config.authBurst).toBe(0);
    expect(config.webhookBurst).toBe(0);
  });
});

describe('createThrottlerOptions', () => {
  const config: ThrottlerConfig = {
    windowSeconds: 60,
    apiLimit: 120,
    authLimit: 10,
    agentLimit: 300,
    webhookLimit: 30,
    apiBurst: 10,
    authBurst: 3,
    webhookBurst: 5,
  };

  it('exposes four steady-state tiers so guards can route by tier', () => {
    const options = createThrottlerOptions(config);

    expect(Array.isArray(options)).toBe(false);
    expect(options.throttlers.filter((t) => !t.name?.endsWith('-burst')).map((t) => t.name)).toEqual([
      'api',
      'auth',
      'agent',
      'webhook',
    ]);
  });

  it('converts the configured window from seconds to the milliseconds @nestjs/throttler expects', () => {
    const options = createThrottlerOptions({ ...config, windowSeconds: 30 });
    const steadyState = options.throttlers.filter((t) => !t.name?.endsWith('-burst'));

    expect(steadyState[0].ttl).toBe(30_000);
    expect(steadyState[1].ttl).toBe(30_000);
    expect(steadyState[2].ttl).toBe(30_000);
    expect(steadyState[3].ttl).toBe(30_000);
  });

  it('applies tier-specific limits to api, auth, agent and webhook', () => {
    const options = createThrottlerOptions(config);

    expect(options.throttlers.find((t) => t.name === 'api')?.limit).toBe(120);
    expect(options.throttlers.find((t) => t.name === 'auth')?.limit).toBe(10);
    expect(options.throttlers.find((t) => t.name === 'agent')?.limit).toBe(300);
    expect(options.throttlers.find((t) => t.name === 'webhook')?.limit).toBe(30);
  });

  it('registers burst throttlers with a 1-second TTL for non-zero burst values', () => {
    const options = createThrottlerOptions(config);

    const apiBurst = options.throttlers.find((t) => t.name === 'api-burst');
    const authBurst = options.throttlers.find((t) => t.name === 'auth-burst');
    const webhookBurst = options.throttlers.find((t) => t.name === 'webhook-burst');

    expect(apiBurst).toBeDefined();
    expect(apiBurst?.ttl).toBe(1_000);
    expect(apiBurst?.limit).toBe(10);

    expect(authBurst).toBeDefined();
    expect(authBurst?.ttl).toBe(1_000);
    expect(authBurst?.limit).toBe(3);

    expect(webhookBurst).toBeDefined();
    expect(webhookBurst?.ttl).toBe(1_000);
    expect(webhookBurst?.limit).toBe(5);
  });

  it('omits burst throttlers when burst limits are zero', () => {
    const noBurstConfig: ThrottlerConfig = { ...config, apiBurst: 0, authBurst: 0, webhookBurst: 0 };
    const options = createThrottlerOptions(noBurstConfig);

    expect(options.throttlers.find((t) => t.name === 'api-burst')).toBeUndefined();
    expect(options.throttlers.find((t) => t.name === 'auth-burst')).toBeUndefined();
    expect(options.throttlers.find((t) => t.name === 'webhook-burst')).toBeUndefined();
  });

  it('attaches the shared Redis storage, without which counters stay in-process', () => {
    const storage = { increment: vi.fn() } as unknown as ThrottlerStorage;

    const options = createThrottlerOptions(config, storage);

    expect(options.storage).toBe(storage);
  });

  it('omits the storage key when none is supplied so the default is used', () => {
    const options = createThrottlerOptions(config);

    expect(options).not.toHaveProperty('storage');
  });
});
