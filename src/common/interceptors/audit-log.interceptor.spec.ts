import { EventEmitter } from 'events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExecutionContext, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, of } from 'rxjs';

import { AuditService } from '../../modules/audit/audit.service';
import { AUDIT_LOG_KEY, AuditLogOptions } from '../decorators/audit-log.decorator';
import { IS_SKIP_AUDIT_KEY } from '../decorators/skip-audit.decorator';
import {
  AuditLogInterceptor,
  hashPayload,
  isSensitiveKey,
  maskSensitiveData,
  REDACTED_VALUE,
} from './audit-log.interceptor';

/** Stand-ins for real controllers so entity resolution can be asserted. */
class PolicyController {}
class WalletController {}

type MockRequest = {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  ip?: string;
  user?: { id: string; organizationId: string; email: string; role: string };
};

function createMockResponse(statusCode = 200): EventEmitter & { statusCode: number } {
  const response = new EventEmitter() as EventEmitter & { statusCode: number };
  response.statusCode = statusCode;
  return response;
}

function createContext(
  request: MockRequest,
  response: EventEmitter & { statusCode: number },
  controller: new () => unknown = PolicyController,
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
    getHandler: () => undefined,
    getClass: () => controller,
  } as unknown as ExecutionContext;
}

/** Reflector stub that only answers the two metadata keys the interceptor reads. */
function makeReflector(stub: { audit?: AuditLogOptions; skip?: boolean } = { audit: {} }): Reflector {
  return {
    getAllAndOverride: vi.fn((key: string) => {
      if (key === AUDIT_LOG_KEY) return stub.audit;
      if (key === IS_SKIP_AUDIT_KEY) return stub.skip;
      return undefined;
    }),
  } as unknown as Reflector;
}

interface InterceptorOptions {
  audit?: AuditLogOptions;
  skip?: boolean;
  trustProxy?: boolean;
}

function makeInterceptor(
  record: ReturnType<typeof vi.fn>,
  options: InterceptorOptions = {},
): AuditLogInterceptor {
  const audit = Object.prototype.hasOwnProperty.call(options, 'audit') ? options.audit : {};
  const { skip = false, trustProxy = false } = options;
  const auditService = { record } as unknown as AuditService;
  const config = { get: vi.fn().mockReturnValue(trustProxy) } as never;
  return new AuditLogInterceptor(auditService, config, makeReflector({ audit, skip }));
}

/** Subscribes so the handler runs, emits `finish`, then waits for the async audit write. */
async function runRequest(
  interceptor: AuditLogInterceptor,
  context: ExecutionContext,
  response: EventEmitter & { statusCode: number },
): Promise<void> {
  const observable = interceptor.intercept(context, {
    handle: () => of({ success: true }),
  });
  await new Promise<void>((resolve, reject) => {
    observable.subscribe({ next: () => resolve(), error: reject });
  });
  response.emit('finish');
  // Let the fire-and-forget audit write settle (it only awaits resolved promises).
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

const OWNER = { id: 'user-1', organizationId: 'org-1', email: 'admin@example.com', role: 'ADMIN' };

function baseRequest(overrides: Partial<MockRequest> = {}): MockRequest {
  return {
    method: 'PATCH',
    path: '/api/v1/policies/pol-123',
    headers: { 'user-agent': 'test-agent' },
    params: { id: 'pol-123' },
    query: {},
    body: { name: 'Daily limit' },
    ip: '127.0.0.1',
    user: OWNER,
    ...overrides,
  };
}

describe('AuditLogInterceptor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('decorated endpoints', () => {
    it('persists actor, method, path, IP, masked body, payload hash and status code', async () => {
      const record = vi.fn().mockResolvedValue(undefined);
      const interceptor = makeInterceptor(record, { trustProxy: true });

      const request = baseRequest({
        headers: { 'user-agent': 'test-agent', 'x-forwarded-for': '203.0.113.5' },
        params: { id: 'pol-123' },
        body: { name: 'Daily limit', configuration: { maxAmount: 100 } },
        ip: '::1',
      });
      const response = createMockResponse(201);
      const context = createContext(request, response);

      await runRequest(interceptor, context, response);

      expect(record).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'org-1',
          userId: 'user-1',
          action: 'PATCH',
          entity: 'Policy',
          entityId: 'pol-123',
          ipAddress: '203.0.113.5',
          device: 'test-agent',
          newValue: expect.objectContaining({
            path: '/api/v1/policies/pol-123',
            body: { name: 'Daily limit', configuration: { maxAmount: 100 } },
            payloadHash: hashPayload({ name: 'Daily limit', configuration: { maxAmount: 100 } }),
            actor: { type: 'USER', id: 'user-1' },
            statusCode: 201,
            durationMs: expect.any(Number),
          }),
        }),
      );
    });

    it('uses the @AuditLog() metadata for the semantic action and entity', async () => {
      const record = vi.fn().mockResolvedValue(undefined);
      const interceptor = makeInterceptor(record, {
        audit: { action: 'POLICY_OVERRIDDEN', entity: 'SpendingPolicy' },
      });

      const request = baseRequest();
      const response = createMockResponse(200);
      const context = createContext(request, response);

      await runRequest(interceptor, context, response);

      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'POLICY_OVERRIDDEN', entity: 'SpendingPolicy' }),
      );
    });

    it('audits a decorated read-only GET, which is not logged by default', async () => {
      const record = vi.fn().mockResolvedValue(undefined);
      const interceptor = makeInterceptor(record);

      const request = baseRequest({ method: 'GET', path: '/api/v1/policies/pol-123' });
      const response = createMockResponse(200);
      const context = createContext(request, response);

      await runRequest(interceptor, context, response);

      expect(record).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'GET' }));
    });

    it('records the acting agent as the actor when no human user is present', async () => {
      const record = vi.fn().mockResolvedValue(undefined);
      const interceptor = makeInterceptor(record);

      const request = baseRequest({
        method: 'POST',
        path: '/api/v1/wallets/wal-1/rotate',
        headers: {
          'user-agent': 'AgentRunner/1.0',
          'x-agent-id': 'agent-9',
          'x-organization-id': 'org-1',
        },
        params: { id: 'wal-1' },
        body: { newLabel: 'ops' },
        user: undefined,
      });
      const response = createMockResponse(200);
      const context = createContext(request, response, WalletController);

      await runRequest(interceptor, context, response);

      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: null,
          action: 'POST',
          entity: 'Wallet',
          newValue: expect.objectContaining({
            agentId: 'agent-9',
            actor: { type: 'AGENT', id: 'agent-9' },
          }),
        }),
      );
    });

    it('records the handler execution duration alongside the response status', async () => {
      const record = vi.fn().mockResolvedValue(undefined);
      const interceptor = makeInterceptor(record);

      const request = baseRequest({ method: 'POST', path: '/api/v1/policies', body: {} });
      const response = createMockResponse(201);
      const context = createContext(request, response);

      const observable = interceptor.intercept(context, {
        handle: () =>
          new Observable((subscriber) => {
            const timer = setTimeout(() => {
              subscriber.next({ success: true });
              subscriber.complete();
            }, 25);
            return () => clearTimeout(timer);
          }),
      });
      await new Promise<void>((resolve, reject) => {
        observable.subscribe({ next: () => resolve(), error: reject });
      });
      response.emit('finish');
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      const { newValue } = record.mock.calls[0][0];
      expect(newValue.durationMs).toBeGreaterThanOrEqual(20);
      expect(newValue.statusCode).toBe(201);
    });
  });

  describe('scope filtering', () => {
    it('never audits an undecorated route, even a state-mutating one', async () => {
      const record = vi.fn().mockResolvedValue(undefined);
      const interceptor = makeInterceptor(record, { audit: undefined });

      const request = baseRequest({ method: 'DELETE' });
      const response = createMockResponse(204);
      const context = createContext(request, response);

      await runRequest(interceptor, context, response);

      expect(record).not.toHaveBeenCalled();
    });

    it('honours @SkipAudit() even when the route is decorated', async () => {
      const record = vi.fn().mockResolvedValue(undefined);
      const interceptor = makeInterceptor(record, { skip: true });

      const request = baseRequest({ method: 'DELETE' });
      const response = createMockResponse(204);
      const context = createContext(request, response);

      await runRequest(interceptor, context, response);

      expect(record).not.toHaveBeenCalled();
    });

    it('skips decorated routes with no organization context (e.g. public routes)', async () => {
      const record = vi.fn().mockResolvedValue(undefined);
      const interceptor = makeInterceptor(record);

      const request = baseRequest({
        method: 'POST',
        path: '/api/v1/auth/login',
        body: { email: 'a@b.com', password: 'secret' },
        user: undefined,
      });
      const response = createMockResponse(200);
      const context = createContext(request, response);

      await runRequest(interceptor, context, response);

      expect(record).not.toHaveBeenCalled();
    });
  });

  describe('sensitive data sanitization', () => {
    it('redacts secrets, preserves safe fields and never mutates the original body', async () => {
      const record = vi.fn().mockResolvedValue(undefined);
      const interceptor = makeInterceptor(record);

      const originalBody = {
        username: 'john',
        password: 'secret-pass',
        apiKey: 'abc123',
        token: 'jwt-token',
        passkey: 'cred-1',
        privateKey: 'SDFJKL-seed',
        webhook: { signature: 'sig-here', url: 'https://example.com/hook' },
        nested: { refreshToken: 'rt-1', note: 'keep me' },
      };
      const request = baseRequest({ method: 'PUT', body: originalBody });
      const response = createMockResponse(200);
      const context = createContext(request, response);

      await runRequest(interceptor, context, response);

      const { newValue } = record.mock.calls[0][0];
      expect(newValue.body).toEqual({
        username: 'john',
        password: REDACTED_VALUE,
        apiKey: REDACTED_VALUE,
        token: REDACTED_VALUE,
        passkey: REDACTED_VALUE,
        privateKey: REDACTED_VALUE,
        webhook: { signature: REDACTED_VALUE, url: 'https://example.com/hook' },
        nested: { refreshToken: REDACTED_VALUE, note: 'keep me' },
      });
      // The original request body must be untouched.
      expect(originalBody.password).toBe('secret-pass');
      expect(originalBody.apiKey).toBe('abc123');
    });

    it('masks sensitive entries inside arrays', () => {
      const masked = maskSensitiveData([
        { label: 'primary', apiKey: 'abc' },
        { label: 'backup', apiKey: 'def' },
      ]);
      expect(masked).toEqual([
        { label: 'primary', apiKey: REDACTED_VALUE },
        { label: 'backup', apiKey: REDACTED_VALUE },
      ]);
    });

    it('detects sensitive keys case-insensitively and across separators', () => {
      expect(isSensitiveKey('password')).toBe(true);
      expect(isSensitiveKey('PasswordHash')).toBe(true);
      expect(isSensitiveKey('apiKey')).toBe(true);
      expect(isSensitiveKey('api_key')).toBe(true);
      expect(isSensitiveKey('x-api-key')).toBe(true);
      expect(isSensitiveKey('accessToken')).toBe(true);
      expect(isSensitiveKey('privateKey')).toBe(true);
      expect(isSensitiveKey('username')).toBe(false);
      expect(isSensitiveKey('amount')).toBe(false);
    });
  });

  describe('payload hashing', () => {
    it('is deterministic for identical payloads', () => {
      expect(hashPayload({ a: 1, b: 'two' })).toBe(hashPayload({ a: 1, b: 'two' }));
    });

    it('changes when the payload changes', () => {
      expect(hashPayload({ amount: 10 })).not.toBe(hashPayload({ amount: 11 }));
    });

    it('hashes an absent body without throwing', () => {
      expect(hashPayload(undefined)).toHaveLength(64);
    });

    it('records the hash of the sanitized body, not the raw secret', async () => {
      const record = vi.fn().mockResolvedValue(undefined);
      const interceptor = makeInterceptor(record);

      const request = baseRequest({ method: 'POST', body: { apiKey: 'super-secret' } });
      const response = createMockResponse(201);
      const context = createContext(request, response);

      await runRequest(interceptor, context, response);

      const { newValue } = record.mock.calls[0][0];
      expect(newValue.payloadHash).toBe(hashPayload({ apiKey: REDACTED_VALUE }));
      expect(JSON.stringify(newValue)).not.toContain('super-secret');
    });
  });

  describe('audit failure handling', () => {
    it('does not crash the request when audit persistence fails and logs the error', async () => {
      const loggerError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const record = vi.fn().mockRejectedValue(new Error('database unreachable'));
      const interceptor = makeInterceptor(record);

      const request = baseRequest({ method: 'DELETE', path: '/api/v1/policies/pol-1' });
      const response = createMockResponse(204);
      const context = createContext(request, response);

      // Must resolve — the failed audit write must not surface to the caller.
      await runRequest(interceptor, context, response);

      expect(record).toHaveBeenCalledTimes(1);
      expect(loggerError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to write audit log for DELETE Policy'),
      );
    });
  });
});
