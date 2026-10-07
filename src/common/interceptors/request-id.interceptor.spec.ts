import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { RequestIdInterceptor } from './request-id.interceptor';
import { REQUEST_ID_HEADER } from '../constants/headers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal mock ExecutionContext for HTTP requests. Callers supply only
 * the fields relevant to their test case.
 */
function buildContext(options: {
  incomingRequestId?: string;
  method?: string;
  path?: string;
}): {
  context: ExecutionContext;
  requestHeaders: Record<string, string | undefined>;
  responseHeaders: Record<string, string>;
  requestRef: { id?: string; headers: Record<string, string | undefined>; method: string; path: string };
} {
  const requestHeaders: Record<string, string | undefined> = {};
  if (options.incomingRequestId !== undefined) {
    requestHeaders[REQUEST_ID_HEADER] = options.incomingRequestId;
  }

  const responseHeaders: Record<string, string> = {};

  const requestRef = {
    id: undefined as string | undefined,
    headers: requestHeaders,
    method: options.method ?? 'GET',
    path: options.path ?? '/api/v1/test',
  };

  const context = {
    switchToHttp: () => ({
      getRequest: () => requestRef,
      getResponse: () => ({
        setHeader: (name: string, value: string) => {
          responseHeaders[name] = value;
        },
        statusCode: 200,
      }),
    }),
  } as unknown as ExecutionContext;

  return { context, requestHeaders, responseHeaders, requestRef };
}

/**
 * Executes the interceptor and resolves once the observable completes or errors.
 */
function run(
  interceptor: RequestIdInterceptor,
  context: ExecutionContext,
  callHandler: CallHandler,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    interceptor.intercept(context, callHandler).subscribe({
      next: (val) => resolve(val),
      error: (err) => reject(err),
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RequestIdInterceptor', () => {
  let interceptor: RequestIdInterceptor;

  beforeEach(() => {
    interceptor = new RequestIdInterceptor();
    // Silence logger output during tests — we assert on behaviour, not log lines.
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  // ── Header preservation ─────────────────────────────────────────────────

  it('should preserve an incoming X-Request-ID header', async () => {
    const { context, requestHeaders, responseHeaders, requestRef } = buildContext({
      incomingRequestId: 'client-provided-id-123',
    });

    const callHandler: CallHandler = { handle: () => of(null) };
    await run(interceptor, context, callHandler);

    // Header kept on the request
    expect(requestHeaders[REQUEST_ID_HEADER]).toBe('client-provided-id-123');
    // Echoed on the response
    expect(responseHeaders[REQUEST_ID_HEADER]).toBe('client-provided-id-123');
    // Attached to request.id
    expect(requestRef.id).toBe('client-provided-id-123');
  });

  it('should preserve a UUID-format X-Request-ID header unchanged', async () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const { context, requestHeaders, responseHeaders } = buildContext({
      incomingRequestId: uuid,
    });

    const callHandler: CallHandler = { handle: () => of(null) };
    await run(interceptor, context, callHandler);

    expect(requestHeaders[REQUEST_ID_HEADER]).toBe(uuid);
    expect(responseHeaders[REQUEST_ID_HEADER]).toBe(uuid);
  });

  // ── Automatic ID generation ──────────────────────────────────────────────

  it('should generate a UUID when no X-Request-ID header is present', async () => {
    const { context, requestHeaders, responseHeaders, requestRef } = buildContext({});

    const callHandler: CallHandler = { handle: () => of(null) };
    await run(interceptor, context, callHandler);

    const generated = requestHeaders[REQUEST_ID_HEADER];
    expect(generated).toBeDefined();
    expect(typeof generated).toBe('string');
    // crypto.randomUUID() produces the standard 8-4-4-4-12 format
    expect(generated).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(responseHeaders[REQUEST_ID_HEADER]).toBe(generated);
    expect(requestRef.id).toBe(generated);
  });

  it('should generate a UUID when the X-Request-ID header is an empty string', async () => {
    const { context, requestHeaders } = buildContext({ incomingRequestId: '' });

    const callHandler: CallHandler = { handle: () => of(null) };
    await run(interceptor, context, callHandler);

    const generated = requestHeaders[REQUEST_ID_HEADER];
    expect(generated).toBeDefined();
    expect(generated).not.toBe('');
    expect(generated).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('should generate a UUID when the X-Request-ID header is whitespace only', async () => {
    const { context, requestHeaders } = buildContext({ incomingRequestId: '   ' });

    const callHandler: CallHandler = { handle: () => of(null) };
    await run(interceptor, context, callHandler);

    const generated = requestHeaders[REQUEST_ID_HEADER];
    expect(generated).toBeDefined();
    expect(generated?.trim()).not.toBe('');
    expect(generated).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('replaces request IDs containing unsupported characters or exceeding 128 characters', async () => {
    for (const incomingRequestId of ['bad id', 'bad\nid', 'x'.repeat(129)]) {
      const { context, requestHeaders, responseHeaders } = buildContext({ incomingRequestId });
      await run(interceptor, context, { handle: () => of(null) });

      expect(requestHeaders[REQUEST_ID_HEADER]).not.toBe(incomingRequestId);
      expect(requestHeaders[REQUEST_ID_HEADER]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(responseHeaders[REQUEST_ID_HEADER]).toBe(requestHeaders[REQUEST_ID_HEADER]);
    }
  });

  it('should generate unique IDs for each request', async () => {
    const { context: ctx1 } = buildContext({});
    const { context: ctx2 } = buildContext({});

    let id1: string | undefined;
    let id2: string | undefined;

    const handler1: CallHandler = {
      handle: () => {
        id1 = (ctx1.switchToHttp().getRequest() as { headers: Record<string, string> }).headers[REQUEST_ID_HEADER];
        return of(null);
      },
    };
    const handler2: CallHandler = {
      handle: () => {
        id2 = (ctx2.switchToHttp().getRequest() as { headers: Record<string, string> }).headers[REQUEST_ID_HEADER];
        return of(null);
      },
    };

    await run(interceptor, ctx1, handler1);
    await run(interceptor, ctx2, handler2);

    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    expect(id1).not.toBe(id2);
  });

  // ── request.id attachment ────────────────────────────────────────────────

  it('should attach the request id to request.id for Express compatibility', async () => {
    const { context, requestRef } = buildContext({ incomingRequestId: 'express-compat-id' });
    const callHandler: CallHandler = { handle: () => of(null) };
    await run(interceptor, context, callHandler);

    expect(requestRef.id).toBe('express-compat-id');
  });

  // ── Response header ──────────────────────────────────────────────────────

  it('should set X-Request-ID on the response even when the handler throws', async () => {
    const { context, responseHeaders } = buildContext({ incomingRequestId: 'error-case-id' });

    const callHandler: CallHandler = {
      handle: () => throwError(() => new Error('handler error')),
    };

    await run(interceptor, context, callHandler).catch(() => {
      // Expected — we just want to inspect the response headers.
    });

    // Response header must be set before handle() is called (synchronous).
    expect(responseHeaders[REQUEST_ID_HEADER]).toBe('error-case-id');
  });

  // ── Structured logging ───────────────────────────────────────────────────

  it('should emit a structured log on request entry', async () => {
    const { context } = buildContext({
      incomingRequestId: 'log-test-id',
      method: 'POST',
      path: '/api/v1/agents',
    });

    const callHandler: CallHandler = { handle: () => of(null) };
    await run(interceptor, context, callHandler);

    expect(Logger.prototype.log).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Request received',
        requestId: 'log-test-id',
        method: 'POST',
        path: '/api/v1/agents',
      }),
    );
  });

  it('should emit a structured log on successful response completion', async () => {
    const { context } = buildContext({
      incomingRequestId: 'log-complete-id',
      method: 'GET',
      path: '/api/v1/wallets',
    });

    const callHandler: CallHandler = { handle: () => of(null) };
    await run(interceptor, context, callHandler);

    expect(Logger.prototype.log).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Request completed',
        requestId: 'log-complete-id',
        method: 'GET',
        path: '/api/v1/wallets',
      }),
    );
  });

  it('should emit a warn log when the handler errors', async () => {
    const { context } = buildContext({
      incomingRequestId: 'log-error-id',
      method: 'DELETE',
      path: '/api/v1/agents/1',
    });

    const callHandler: CallHandler = {
      handle: () => throwError(() => new Error('something went wrong')),
    };

    await run(interceptor, context, callHandler).catch(() => undefined);

    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Request errored',
        requestId: 'log-error-id',
        error: 'something went wrong',
      }),
    );
  });
});
