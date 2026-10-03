import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of, throwError } from 'rxjs';
import { AuditInterceptor } from './audit.interceptor';
import { AuditService } from '../../modules/audit/audit.service';
import { AUDIT_ACTION_KEY } from '../decorators/audit-action.decorator';
import { IS_SKIP_AUDIT_KEY } from '../decorators/skip-audit.decorator';
import { TraceContext } from '../context/trace.context';

function buildMockContext(overrides: {
  url?: string;
  method?: string;
  body?: Record<string, unknown>;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  user?: { id: string; organizationId: string } | null;
  statusCode?: number;
} = {}) {
  const hasUser = 'user' in overrides;
  const req = {
    originalUrl: overrides.url ?? '/v1/transactions',
    method: overrides.method ?? 'POST',
    body: overrides.body ?? { amount: 100, asset: 'XLM' },
    params: overrides.params ?? {},
    query: overrides.query ?? {},
    headers: { 'user-agent': 'TestAgent/1.0' },
    user: hasUser ? overrides.user : { id: 'user-1', organizationId: 'org-1' },
    socket: { remoteAddress: '127.0.0.1' },
  };

  const res = { statusCode: overrides.statusCode ?? 201 };

  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
    getHandler: () => vi.fn(),
    getClass: () => vi.fn(),
  } as unknown as ExecutionContext;
}

function buildCallHandler(returnValue: unknown = { id: '1' }): CallHandler {
  return { handle: () => of(returnValue) };
}

function buildErrorCallHandler(error: Error): CallHandler {
  return { handle: () => throwError(() => error) };
}

describe('AuditInterceptor', () => {
  let reflector: Reflector;
  let auditService: { record: ReturnType<typeof vi.fn> };
  let interceptor: AuditInterceptor;

  beforeEach(() => {
    vi.clearAllMocks();
    reflector = new Reflector();
    auditService = { record: vi.fn().mockResolvedValue(undefined) };
    interceptor = new AuditInterceptor(reflector, auditService as unknown as AuditService);
  });

  it('should persist an audit log on successful request', async () => {
    const ctx = buildMockContext();
    const next = buildCallHandler();

    await interceptor.intercept(ctx, next).toPromise();

    expect(auditService.record).toHaveBeenCalledWith({
      organizationId: 'org-1',
      userId: 'user-1',
      action: 'POST /v1/transactions',
      entity: 'http',
      entityId: null,
      newValue: expect.objectContaining({
        method: 'POST',
        url: '/v1/transactions',
        statusCode: 201,
      }),
      ipAddress: '127.0.0.1',
      device: 'TestAgent/1.0',
      requestId: null,
    });
  });

  it('should persist an audit log on error response', async () => {
    const ctx = buildMockContext({ statusCode: 500 });
    const next = buildErrorCallHandler(new Error('boom'));

    await interceptor.intercept(ctx, next).toPromise().catch(() => {});

    expect(auditService.record).toHaveBeenCalled();
  });

  it('should scrub sensitive fields from request body', async () => {
    const ctx = buildMockContext({
      body: {
        amount: 100,
        secret: 'super-secret-key',
        password: 'hunter2',
        nested: { privateKey: 'abc123', safe: 'ok' },
      },
    });
    const next = buildCallHandler();

    await interceptor.intercept(ctx, next).toPromise();

    const call = auditService.record.mock.calls[0][0];
    const loggedBody = call.newValue.body;
    expect(loggedBody.amount).toBe(100);
    expect(loggedBody.secret).toBe('[REDACTED]');
    expect(loggedBody.password).toBe('[REDACTED]');
    expect(loggedBody.nested.privateKey).toBe('[REDACTED]');
    expect(loggedBody.nested.safe).toBe('ok');
  });

  it('should skip audit when @SkipAudit() is applied', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);

    const ctx = buildMockContext();
    const next = buildCallHandler();

    await interceptor.intercept(ctx, next).toPromise();

    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('should not audit requests without organizationId', async () => {
    const ctx = buildMockContext({ user: null });
    const next = buildCallHandler();

    await interceptor.intercept(ctx, next).toPromise();

    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('should handle forwarded IP from x-forwarded-for header', async () => {
    const ctx = buildMockContext();
    const req = (ctx.switchToHttp() as ReturnType<ExecutionContext['switchToHttp']>)[
      'getRequest'
    ]() as Record<string, unknown> & { headers: Record<string, string> };
    req.headers['x-forwarded-for'] = '10.0.0.1, 10.0.0.2';

    const next = buildCallHandler();
    await interceptor.intercept(ctx, next).toPromise();

    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ ipAddress: '10.0.0.1' }),
    );
  });

  it('should use the @AuditAction() name instead of METHOD /url when present', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: unknown) => {
      if (key === IS_SKIP_AUDIT_KEY) return false;
      if (key === AUDIT_ACTION_KEY) return 'TRANSFER_FUNDS';
      return undefined;
    });

    const ctx = buildMockContext();
    const next = buildCallHandler();

    await interceptor.intercept(ctx, next).toPromise();

    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'TRANSFER_FUNDS' }),
    );
  });

  it('should capture the request id from TraceContext (AsyncLocalStorage)', async () => {
    const ctx = buildMockContext();
    const next = buildCallHandler();

    await TraceContext.run({ traceId: 'req_trace-abc-123' }, () =>
      interceptor.intercept(ctx, next).toPromise(),
    );

    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req_trace-abc-123' }),
    );
  });

  it('should persist sanitized route params and query for structured metadata', async () => {
    const ctx = buildMockContext({
      url: '/v1/wallets/wal-123/freeze',
      method: 'POST',
      params: { id: 'wal-123' },
      query: { dryRun: 'true' },
    });
    const next = buildCallHandler();

    await interceptor.intercept(ctx, next).toPromise();

    const call = auditService.record.mock.calls[0][0];
    expect(call.newValue).toEqual(
      expect.objectContaining({
        params: { id: 'wal-123' },
        query: { dryRun: 'true' },
      }),
    );
  });

  it('should scrub sensitive fields nested inside route params', async () => {
    const ctx = buildMockContext({
      url: '/v1/agents/agent-1/wallet',
      method: 'POST',
      params: { id: 'agent-1', secret: 'should-never-log' },
    });
    const next = buildCallHandler();

    await interceptor.intercept(ctx, next).toPromise();

    const call = auditService.record.mock.calls[0][0];
    expect(call.newValue.params).toEqual({ id: 'agent-1', secret: '[REDACTED]' });
  });

  it('should strip authorization-like keys from the query string', async () => {
    const ctx = buildMockContext({
      url: '/v1/transactions?token=abc123',
      method: 'POST',
      query: { token: 'abc123', page: '2' },
    });
    const next = buildCallHandler();

    await interceptor.intercept(ctx, next).toPromise();

    const call = auditService.record.mock.calls[0][0];
    expect(call.newValue.query).toEqual({ page: '2' });
  });

  it('should capture the agent identity from TraceContext as the actor', async () => {
    const ctx = buildMockContext();
    const next = buildCallHandler();

    await TraceContext.run({ traceId: 'req_trace-abc-123', agentId: 'agent-88' }, () =>
      interceptor.intercept(ctx, next).toPromise(),
    );

    const call = auditService.record.mock.calls[0][0];
    expect(call.newValue.agentId).toBe('agent-88');
  });
});
