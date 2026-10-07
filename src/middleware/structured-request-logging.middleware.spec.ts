import { describe, expect, it, vi } from 'vitest';
import { Request, Response } from 'express';
import { StructuredRequestLoggingMiddleware } from './structured-request-logging.middleware';

function buildResponse(): Response {
  const listeners: Record<string, () => void> = {};
  return {
    statusCode: 201,
    on: (event: string, callback: () => void) => {
      listeners[event] = callback;
      return undefined as unknown as Response;
    },
    emit: (event: string) => listeners[event]?.(),
  } as unknown as Response;
}

describe('StructuredRequestLoggingMiddleware', () => {
  it('logs safe structured request metadata when the response finishes', () => {
    const info = vi.fn();
    const req = {
      id: 'req-1',
      log: { info },
      method: 'POST',
      path: '/api/v1/agents',
      headers: { authorization: 'secret' },
      body: { secret: 'secret' },
    } as unknown as Request;
    const res = buildResponse();
    const next = vi.fn();
    const middleware = new StructuredRequestLoggingMiddleware();

    middleware.use(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    (res as unknown as { emit: (event: string) => void }).emit('finish');

    expect(info).toHaveBeenCalledWith(
      {
        requestId: 'req-1',
        method: 'POST',
        path: '/api/v1/agents',
        statusCode: 201,
        durationMs: expect.any(Number),
      },
      'HTTP request completed',
    );
  });
});
