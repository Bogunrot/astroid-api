import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { ThrottlerOptions, ThrottlerRequest } from '@nestjs/throttler';

import { createThrottlerOptions, ThrottlerConfig } from '../../config/throttler.config';
import { THROTTLE_TIER_KEY, ThrottleTier } from '../decorators/throttle-tier.decorator';
import { AgentThrottlerGuard } from './agent-throttler.guard';

/** Shape returned by `ThrottlerStorage#increment` (not re-exported by the lib). */
type ThrottlerStorageRecord = Awaited<
  ReturnType<AgentThrottlerGuard['storageService']['increment']>
>;

const CONFIG: ThrottlerConfig = {
  windowSeconds: 60,
  apiLimit: 120,
  authLimit: 10,
  agentLimit: 300,
  webhookLimit: 30,
  apiBurst: 10,
  authBurst: 3,
  webhookBurst: 5,
};
const AGENT_LIMIT = 300;

const UNBLOCKED: ThrottlerStorageRecord = {
  totalHits: 1,
  timeToExpire: 60,
  isBlocked: false,
  timeToBlockExpire: 0,
};

const BLOCKED: ThrottlerStorageRecord = {
  totalHits: AGENT_LIMIT + 1,
  timeToExpire: 30,
  isBlocked: true,
  timeToBlockExpire: 30,
};

type MockResponse = { header: ReturnType<typeof vi.fn>; setHeader: ReturnType<typeof vi.fn> };

function buildContext(
  request: Record<string, unknown>,
  response: MockResponse,
): ExecutionContext {
  const handler = () => undefined;
  return {
    getHandler: () => handler,
    getClass: () => class TransactionController {},
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

function throttlerNamed(name: string): ThrottlerOptions {
  const limit = name === 'agent' ? AGENT_LIMIT : name === 'auth' ? 10 : 120;
  return { name, ttl: 60_000, limit };
}

async function prepare(
  opts: {
    tier?: ThrottleTier;
    increment?: ReturnType<typeof vi.fn>;
    request?: Record<string, unknown>;
  } = {},
) {
  const increment = opts.increment ?? vi.fn().mockResolvedValue(UNBLOCKED);
  const reflector = {
    getAllAndOverride: vi.fn((key: string) => (key === THROTTLE_TIER_KEY ? opts.tier : undefined)),
  };
  const guard = new AgentThrottlerGuard(
    createThrottlerOptions(CONFIG),
    { increment } as never,
    reflector as never,
  );
  await guard.onModuleInit();

  const request = opts.request ?? { ip: '203.0.113.7', headers: {}, params: {}, query: {} };
  const response: MockResponse = { header: vi.fn(), setHeader: vi.fn() };
  const context = buildContext(request, response);
  const { getTracker, generateKey } = (
    guard as unknown as { commonOptions: Pick<ThrottlerRequest, 'getTracker' | 'generateKey'> }
  ).commonOptions;

  const call = (throttler: ThrottlerOptions) =>
    guard['handleRequest']({
      context,
      limit: throttler.limit as number,
      ttl: 60_000,
      throttler,
      blockDuration: 60_000,
      getTracker,
      generateKey,
    } as ThrottlerRequest);

  const trackerFor = (req: Record<string, unknown>) =>
    (
      guard as unknown as { getTracker: (r: Record<string, unknown>) => Promise<string> }
    ).getTracker(req);

  return { guard, increment, response, call, trackerFor };
}

describe('AgentThrottlerGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('tier routing', () => {
    it('routes agent-identified traffic to the agent tier only', async () => {
      const { increment, call } = await prepare({
        request: { ip: '198.51.100.9', headers: { 'x-agent-id': 'agent-1' }, params: {} },
      });

      await expect(call(throttlerNamed('api'))).resolves.toBe(true);
      expect(increment).not.toHaveBeenCalled();

      await expect(call(throttlerNamed('agent'))).resolves.toBe(true);
      expect(increment).toHaveBeenCalledWith(
        expect.any(String),
        60_000,
        AGENT_LIMIT,
        60_000,
        'agent',
      );
    });

    it('falls back to the api tier for plain user traffic', async () => {
      const { increment, call } = await prepare({
        request: { ip: '198.51.100.9', headers: {}, params: {}, user: { organizationId: 'org-1' } },
      });

      await expect(call(throttlerNamed('agent'))).resolves.toBe(true);
      expect(increment).not.toHaveBeenCalled();

      await expect(call(throttlerNamed('api'))).resolves.toBe(true);
      expect(increment).toHaveBeenCalledTimes(1);
    });

    it('lets an explicit auth tier win over agent auto-detection', async () => {
      const { increment, call } = await prepare({
        tier: 'auth',
        request: { ip: '198.51.100.9', headers: { 'x-agent-id': 'agent-1' }, params: {} },
      });

      await expect(call(throttlerNamed('agent'))).resolves.toBe(true);
      expect(increment).not.toHaveBeenCalled();

      await expect(call(throttlerNamed('auth'))).resolves.toBe(true);
      expect(increment).toHaveBeenCalledWith(expect.any(String), 60_000, 10, 60_000, 'auth');
    });
  });

  describe('agent-aware tracking', () => {
    it('prefers the agent id from the header, body or route params', async () => {
      const { trackerFor } = await prepare();

      await expect(
        trackerFor({ headers: { 'x-agent-id': 'agent-1' }, ip: '1.1.1.1' }),
      ).resolves.toBe('agent:agent-1');
      await expect(
        trackerFor({ headers: {}, body: { agentId: 'agent-2' }, ip: '1.1.1.1' }),
      ).resolves.toBe('agent:agent-2');
      await expect(
        trackerFor({ headers: {}, params: { agentId: 'agent-3' }, ip: '1.1.1.1' }),
      ).resolves.toBe('agent:agent-3');
    });

    it('treats an API-key principal as the acting agent', async () => {
      const { trackerFor } = await prepare();

      await expect(
        trackerFor({ headers: {}, ip: '1.1.1.1', user: { id: 'agent-key-1', isApiKey: true } }),
      ).resolves.toBe('agent:agent-key-1');
    });

    it('buckets authenticated humans by organization and hashes raw API keys', async () => {
      const { trackerFor } = await prepare();

      await expect(
        trackerFor({
          headers: {},
          ip: '1.1.1.1',
          user: { id: 'user-1', organizationId: 'org-1' },
        }),
      ).resolves.toBe('org:org-1');

      const keyed = await trackerFor({
        headers: { 'x-api-key': 'ast_live_secret' },
        ip: '1.1.1.1',
      });
      expect(keyed).toMatch(/^key:[a-f0-9]{64}$/);
      expect(keyed).not.toContain('ast_live_secret');
    });

    it('falls back to the forwarded-for address for anonymous public routes', async () => {
      const { trackerFor } = await prepare();

      await expect(
        trackerFor({ headers: { 'x-forwarded-for': '198.51.100.4' }, ip: '10.0.0.1' }),
      ).resolves.toBe('ip:198.51.100.4');
    });
  });

  describe('rate-limit headers', () => {
    it('advertises the tier limit on an allowed request', async () => {
      const { response, call } = await prepare({
        request: { headers: { 'x-agent-id': 'agent-1' }, params: {}, ip: '1.1.1.1' },
      });

      await call(throttlerNamed('agent'));

      expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', AGENT_LIMIT);
      expect(response.header).toHaveBeenCalledWith(
        'X-RateLimit-Remaining-agent',
        AGENT_LIMIT - 1,
      );
    });

    it('returns 429 with Retry-After and rate-limit headers once the burst is exhausted', async () => {
      const { response, call } = await prepare({
        increment: vi.fn().mockResolvedValue(BLOCKED),
        request: { headers: { 'x-agent-id': 'agent-1' }, params: {}, ip: '1.1.1.1' },
      });

      await expect(call(throttlerNamed('agent'))).rejects.toMatchObject({ status: 429 });

      expect(response.setHeader).toHaveBeenCalledWith('Retry-After', 30);
      expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', AGENT_LIMIT);
      expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', 0);
    });
  });
});
