import { describe, it, expect } from 'vitest';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of } from 'rxjs';
import { RequestContextInterceptor } from './request-context.interceptor';
import { RequestContext } from '../context/request-context';

describe('RequestContextInterceptor', () => {
  const interceptor = new RequestContextInterceptor();

  it('should seed structured context from an authenticated request', async () => {
    let captured = {
      requestId: undefined as string | undefined,
      correlationId: undefined as string | undefined,
      traceId: undefined as string | undefined,
      userId: undefined as string | undefined,
      organizationId: undefined as string | undefined,
      method: undefined as string | undefined,
      path: undefined as string | undefined,
      ip: undefined as string | null | undefined,
      role: undefined as string | undefined,
    };

    const mockExecutionContext = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: {
            'x-request-id': 'req-abc',
            'x-correlation-id': 'corr-xyz',
            'x-forwarded-for': '203.0.113.9, 70.41.3.18',
            'user-agent': 'curl/8.0',
          },
          params: {},
          body: {},
          query: {},
          user: { id: 'user-1', organizationId: 'org-1', role: 'OWNER' },
          method: 'POST',
          path: '/api/v1/wallets',
          originalUrl: '/api/v1/wallets',
          url: '/api/v1/wallets',
          socket: { remoteAddress: '127.0.0.1' },
        }),
      }),
    } as unknown as ExecutionContext;

    const mockCallHandler: CallHandler = {
      handle: () => {
        captured = {
          requestId: RequestContext.getRequestId(),
          correlationId: RequestContext.getCorrelationId(),
          traceId: RequestContext.getTraceId(),
          userId: RequestContext.getUserId(),
          organizationId: RequestContext.getOrganizationId(),
          method: RequestContext.getMethod(),
          path: RequestContext.getPath(),
          ip: RequestContext.getStore()?.identity.ip,
          role: RequestContext.getPrincipal()?.role,
        };
        return of({ success: true });
      },
    };

    const observable = interceptor.intercept(mockExecutionContext, mockCallHandler);

    await new Promise<void>((resolve, reject) => {
      observable.subscribe({
        next: () => resolve(),
        error: (err) => reject(err),
      });
    });

    expect(captured.requestId).toBe('req-abc');
    expect(captured.correlationId).toBe('corr-xyz');
    expect(captured.traceId).toBe('corr-xyz');
    expect(captured.userId).toBe('user-1');
    expect(captured.organizationId).toBe('org-1');
    expect(captured.role).toBe('OWNER');
    expect(captured.method).toBe('POST');
    expect(captured.path).toBe('/api/v1/wallets');
    expect(captured.ip).toBe('203.0.113.9');
  });

  it('should generate a request id and default correlation/trace when none provided', async () => {
    let capturedRequestId: string | undefined;
    let capturedCorrelation: string | undefined;

    const mockExecutionContext = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: {},
          params: {},
          body: {},
          query: {},
          method: 'GET',
          path: '/api/v1/status',
          originalUrl: '/api/v1/status',
          url: '/api/v1/status',
          socket: {},
        }),
      }),
    } as unknown as ExecutionContext;

    const mockCallHandler: CallHandler = {
      handle: () => {
        capturedRequestId = RequestContext.getRequestId();
        capturedCorrelation = RequestContext.getCorrelationId();
        return of({ ok: true });
      },
    };

    const observable = interceptor.intercept(mockExecutionContext, mockCallHandler);

    await new Promise<void>((resolve, reject) => {
      observable.subscribe({
        next: () => resolve(),
        error: (err) => reject(err),
      });
    });

    expect(capturedRequestId).toBeDefined();
    expect(capturedCorrelation).toBe(capturedRequestId);
  });

  it('should resolve an implicit organization/agent principal for service traffic', async () => {
    let capturedOrg: string | undefined;
    let capturedAgent: string | undefined;
    let capturedAuthMethod: string | undefined;

    const mockExecutionContext = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { 'x-agent-id': 'agent-9' },
          params: { organizationId: 'org-9' },
          body: { agentId: 'agent-9' },
          query: {},
          method: 'POST',
          path: '/api/v1/orgs/org-9/agents/agent-9/execute',
          originalUrl: '/api/v1/orgs/org-9/agents/agent-9/execute',
          url: '/api/v1/orgs/org-9/agents/agent-9/execute',
          socket: {},
        }),
      }),
    } as unknown as ExecutionContext;

    const mockCallHandler: CallHandler = {
      handle: () => {
        capturedOrg = RequestContext.getOrganizationId();
        capturedAgent = RequestContext.getAgentId();
        capturedAuthMethod = RequestContext.getPrincipal()?.authMethod;
        return of({ ok: true });
      },
    };

    const observable = interceptor.intercept(mockExecutionContext, mockCallHandler);

    await new Promise<void>((resolve, reject) => {
      observable.subscribe({
        next: () => resolve(),
        error: (err) => reject(err),
      });
    });

    expect(capturedOrg).toBe('org-9');
    expect(capturedAgent).toBe('agent-9');
    expect(capturedAuthMethod).toBe('service');
  });

  it('keeps request IDs isolated across concurrent async contexts', async () => {
    const makeContext = (requestId: string) => ({
      identity: {
        requestId,
        correlationId: requestId,
        traceId: requestId,
        method: 'GET',
        path: '/',
        url: '/',
        ip: null,
        userAgent: null,
        startedAt: Date.now(),
      },
      timings: {},
      data: {},
    });

    const results = await Promise.all(
      ['req-concurrent-a', 'req-concurrent-b'].map((requestId) =>
        RequestContext.run(makeContext(requestId), async () => {
          await new Promise((resolve) => setImmediate(resolve));
          return RequestContext.getRequestId();
        }),
      ),
    );

    expect(results).toEqual(['req-concurrent-a', 'req-concurrent-b']);
  });
});
