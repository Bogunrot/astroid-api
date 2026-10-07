import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of, throwError, Observable } from 'rxjs';
import { MetricsInterceptor } from './metrics.interceptor';
import { MetricsService } from '../../modules/metrics/metrics.service';
import { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('MetricsInterceptor', () => {
  let interceptor: MetricsInterceptor;
  let metricsService: {
    observeHttpRequest: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    metricsService = {
      observeHttpRequest: vi.fn(),
    };
    interceptor = new MetricsInterceptor(metricsService as unknown as MetricsService);
  });

  it('should be defined', () => {
    expect(interceptor).toBeDefined();
  });

  it('should record metrics on successful request', () => {
    const context = createMockExecutionContext('GET', '/api/test', 200);
    const handler = createMockCallHandler(of({ data: 'success' }));

    interceptor.intercept(context, handler).subscribe();

    expect(metricsService.observeHttpRequest).toHaveBeenCalledWith(
      'GET',
      '/api/test',
      200,
      expect.any(Number),
    );
  });

  it('should record metrics on failed request', () => {
    const context = createMockExecutionContext('POST', '/api/error', 500);
    const handler = createMockCallHandler(throwError(new Error('Test error')));

    interceptor.intercept(context, handler).subscribe({
      error: () => {
        // Expected error
      },
    });

    expect(metricsService.observeHttpRequest).toHaveBeenCalledWith(
      'POST',
      '/api/error',
      500,
      expect.any(Number),
    );
  });

  it('should skip metrics collection for /metrics endpoint', () => {
    const context = createMockExecutionContext('GET', '/metrics', 200);
    const handler = createMockCallHandler(of({}));

    interceptor.intercept(context, handler).subscribe();

    expect(metricsService.observeHttpRequest).not.toHaveBeenCalled();
  });

  it('should normalize route paths before recording', () => {
    const context = createMockExecutionContext('GET', '/api/users/123', 200);
    const handler = createMockCallHandler(of({}));

    interceptor.intercept(context, handler).subscribe();

    expect(metricsService.observeHttpRequest).toHaveBeenCalledWith(
      'GET',
      '/api/users/:id',
      200,
      expect.any(Number),
    );
  });

  it('should track active request count', () => {
    const context1 = createMockExecutionContext('GET', '/api/test1', 200);
    const context2 = createMockExecutionContext('GET', '/api/test2', 200);
    const handler = createMockCallHandler(of({}));

    expect(interceptor.getActiveRequestCount()).toBe(0);

    const sub1 = interceptor.intercept(context1, handler);
    expect(interceptor.getActiveRequestCount()).toBe(1);

    const sub2 = interceptor.intercept(context2, handler);
    expect(interceptor.getActiveRequestCount()).toBe(2);

    sub1.subscribe();
    expect(interceptor.getActiveRequestCount()).toBe(1);

    sub2.subscribe();
    expect(interceptor.getActiveRequestCount()).toBe(0);
  });

  it('should not fail request when metrics recording throws error', () => {
    metricsService.observeHttpRequest.mockImplementation(() => {
      throw new Error('Metrics recording failed');
    });

    const context = createMockExecutionContext('GET', '/api/test', 200);
    const handler = createMockCallHandler(of({ data: 'success' }));

    const result = interceptor.intercept(context, handler);

    // Should complete successfully despite metrics error
    expect(() => {
      result.subscribe();
    }).not.toThrow();
  });

  it('should record metrics with different HTTP methods', () => {
    const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;

    methods.forEach((method) => {
      metricsService.observeHttpRequest.mockClear();
      const context = createMockExecutionContext(method, '/api/test', 200);
      const handler = createMockCallHandler(of({}));

      interceptor.intercept(context, handler).subscribe();

      expect(metricsService.observeHttpRequest).toHaveBeenCalledWith(
        method,
        '/api/test',
        200,
        expect.any(Number),
      );
    });
  });

  it('should record metrics with different status codes', () => {
    const statusCodes = [200, 201, 204, 400, 401, 403, 404, 500, 503];

    statusCodes.forEach((statusCode) => {
      metricsService.observeHttpRequest.mockClear();
      const context = createMockExecutionContext('GET', '/api/test', statusCode);
      const handler = createMockCallHandler(of({}));

      interceptor.intercept(context, handler).subscribe();

      expect(metricsService.observeHttpRequest).toHaveBeenCalledWith(
        'GET',
        '/api/test',
        statusCode,
        expect.any(Number),
      );
    });
  });
});

function createMockExecutionContext(
  method: string,
  path: string,
  statusCode: number,
): ExecutionContext {
  const req = {
    method,
    path,
    headers: {},
  } as Partial<Request>;

  const res = {
    statusCode,
  } as Partial<Response>;

  return {
    switchToHttp: () => ({
      getRequest: () => req as Request,
      getResponse: () => res as Response,
    }),
  } as unknown as ExecutionContext;
}

function createMockCallHandler<T>(observable: Observable<T>): CallHandler {
  return {
    handle: () => observable,
  };
}
