import { describe, expect, it, beforeEach } from 'vitest';
import { ResponseInterceptor } from './response.interceptor';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of } from 'rxjs';
import { REQUEST_ID_HEADER } from '../constants/headers';
import { Paginated } from '../interfaces/api-response.interface';

describe('ResponseInterceptor', () => {
  let interceptor: ResponseInterceptor<unknown>;

  beforeEach(() => {
    interceptor = new ResponseInterceptor();
  });

  const createMockContext = (requestId?: string): ExecutionContext => {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: requestId ? { [REQUEST_ID_HEADER]: requestId } : {},
        }),
        getResponse: () => ({
          setHeader: () => undefined,
        }),
      }),
    } as unknown as ExecutionContext;
  };

  const createMockHandler = (returnValue: unknown): CallHandler => {
    return {
      handle: () => of(returnValue),
    } as unknown as CallHandler;
  };

  describe('intercept', () => {
    it('wraps successful responses in success envelope', async () => {
      const context = createMockContext('test-request-id');
      const handler = createMockHandler({ data: 'test' });

      const result = await interceptor.intercept(context, handler).toPromise();
      if (!result) throw new Error('Result should be defined');
      expect(result).toEqual({
        success: true,
        data: { data: 'test' },
        meta: {},
        requestId: 'test-request-id',
      });
    });

    it('handles null data', async () => {
      const context = createMockContext();
      const handler = createMockHandler(null);

      const result = await interceptor.intercept(context, handler).toPromise();
      if (!result) throw new Error('Result should be defined');
      expect(result).toEqual({
        success: true,
        data: null,
        meta: {},
        requestId: 'unknown',
      });
    });

    it('extracts items and meta from Paginated responses', async () => {
      const paginated = new Paginated(
        [{ id: '1' }, { id: '2' }],
        { total: 2, page: 1, limit: 10, offset: 0, totalPages: 1, hasNext: false, hasPrev: false },
      );

      const context = createMockContext('test-request-id');
      const handler = createMockHandler(paginated);

      const result = await interceptor.intercept(context, handler).toPromise();
      expect(result).toBeDefined();
      if (!result) throw new Error('Result should be defined');
      expect(result).toEqual({
        success: true,
        data: [{ id: '1' }, { id: '2' }],
        meta: { total: 2, page: 1, limit: 10, offset: 0, totalPages: 1, hasNext: false, hasPrev: false },
        requestId: 'test-request-id',
      });
    });

    it('uses unknown requestId when header is missing', async () => {
      const context = createMockContext();
      const handler = createMockHandler({ data: 'test' });

      const result = await interceptor.intercept(context, handler).toPromise();
      if (!result) throw new Error('Result should be defined');
      expect(result.requestId).toBe('unknown');
    });
  });
});
