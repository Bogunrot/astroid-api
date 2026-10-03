import { describe, it, expect } from 'vitest';
import { RequestContext, RequestContextData } from './request-context';

describe('RequestContext', () => {
  const baseContext = (): RequestContextData => ({
    identity: {
      requestId: 'req_123',
      correlationId: 'corr_123',
      traceId: 'trace_123',
      method: 'POST',
      path: '/api/v1/agents/agent-1/execute',
      url: '/api/v1/agents/agent-1/execute',
      ip: '127.0.0.1',
      userAgent: 'test-agent',
      startedAt: 1000,
    },
    principal: { userId: 'user-1', organizationId: 'org-1', agentId: 'agent-1' },
    timings: {},
    data: {},
  });

  it('should expose the store within a run() boundary and nothing outside', () => {
    RequestContext.run(baseContext(), () => {
      expect(RequestContext.getStore()).toEqual(baseContext());
      expect(RequestContext.get()).toEqual(baseContext());
    });

    expect(RequestContext.getStore()).toBeUndefined();
  });

  it('should propagate the context across async continuations', async () => {
    let captured: RequestContextData | undefined;

    await new Promise<void>((resolve) => {
      RequestContext.run(baseContext(), () => {
        setTimeout(() => {
          captured = RequestContext.getStore();
          resolve();
        }, 5);
      });
    });

    expect(captured?.identity.requestId).toBe('req_123');
  });

  it('should expose typed identity getters', () => {
    RequestContext.run(baseContext(), () => {
      expect(RequestContext.getRequestId()).toBe('req_123');
      expect(RequestContext.getCorrelationId()).toBe('corr_123');
      expect(RequestContext.getTraceId()).toBe('trace_123');
      expect(RequestContext.getMethod()).toBe('POST');
      expect(RequestContext.getPath()).toBe('/api/v1/agents/agent-1/execute');
      expect(RequestContext.getStartedAt()).toBe(1000);
    });
  });

  it('should expose typed principal getters', () => {
    RequestContext.run(baseContext(), () => {
      expect(RequestContext.getPrincipal()).toEqual({
        userId: 'user-1',
        organizationId: 'org-1',
        agentId: 'agent-1',
      });
      expect(RequestContext.getUserId()).toBe('user-1');
      expect(RequestContext.getOrganizationId()).toBe('org-1');
      expect(RequestContext.getAgentId()).toBe('agent-1');
    });
  });

  it('should return undefined getters when no context is active', () => {
    expect(RequestContext.getRequestId()).toBeUndefined();
    expect(RequestContext.getUserId()).toBeUndefined();
    expect(RequestContext.getOrganizationId()).toBeUndefined();
    expect(RequestContext.getAgentId()).toBeUndefined();
  });

  it('should merge a partial principal via setPrincipal', () => {
    RequestContext.run(baseContext(), () => {
      RequestContext.setPrincipal({ role: 'ADMIN' as const, authMethod: 'jwt' });
      expect(RequestContext.getPrincipal()).toEqual({
        userId: 'user-1',
        organizationId: 'org-1',
        agentId: 'agent-1',
        role: 'ADMIN',
        authMethod: 'jwt',
      });
    });
  });

  it('should store and read arbitrary request-scoped data', () => {
    RequestContext.run(baseContext(), () => {
      expect(RequestContext.getData('cart')).toBeUndefined();
      RequestContext.setData('cart', { count: 3 });
      expect(RequestContext.getData('cart')).toEqual({ count: 3 });
    });
  });

  it('should record and read timings measured from request start', () => {
    RequestContext.run(baseContext(), () => {
      RequestContext.markTiming('db');
      const timing = RequestContext.getTiming('db');
      expect(typeof timing).toBe('number');
      expect(timing!).toBeGreaterThanOrEqual(0);
    });
  });

  it('should not throw when mutating with no active context', () => {
    expect(() => {
      RequestContext.setPrincipal({ userId: 'x' });
      RequestContext.setData('k', 'v');
      RequestContext.markTiming('nope');
    }).not.toThrow();

    expect(RequestContext.getData('k')).toBeUndefined();
    expect(RequestContext.getTiming('nope')).toBeUndefined();
  });
});
