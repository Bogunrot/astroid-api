import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of, lastValueFrom, Observable } from 'rxjs';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import Redis from 'ioredis';

describe('IdempotencyInterceptor', () => {
  let interceptor: IdempotencyInterceptor;
  let reflector: Reflector;
  let mockRedis: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    reflector = new Reflector();
    mockRedis = {
      get: vi.fn(),
      set: vi.fn().mockResolvedValue('OK'),
    };
    interceptor = new IdempotencyInterceptor(reflector, mockRedis as unknown as Redis);
  });

  it('should bypass when @Idempotent() decorator is not present', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ headers: {}, method: 'POST', path: '/test' }),
        getResponse: () => ({ status: vi.fn() }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    const callHandler: CallHandler = {
      handle: () => of({ success: true }),
    };

    const result = await lastValueFrom(await interceptor.intercept(context, callHandler));
    expect(result).toEqual({ success: true });
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  it('should return cached response on cache hit', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue({ ttl: 3600 });
    mockRedis.get.mockResolvedValue(
      JSON.stringify({
        statusCode: 201,
        body: { id: 'cached-123' },
        headers: { 'x-custom': 'val' },
      }),
    );

    const setHeader = vi.fn();
    const status = vi.fn();
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { 'idempotency-key': 'key-abc' },
          method: 'POST',
          path: '/test',
        }),
        getResponse: () => ({ status, setHeader }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    const callHandler: CallHandler = {
      handle: vi.fn().mockReturnValue(of({ id: 'new-123' })),
    };

    const result = await lastValueFrom(await interceptor.intercept(context, callHandler));
    expect(result).toEqual({ id: 'cached-123' });
    expect(status).toHaveBeenCalledWith(201);
    expect(setHeader).toHaveBeenCalledWith('x-custom', 'val');
    expect(mockRedis.get).toHaveBeenCalledWith('idempotency:POST:/test:key-abc');
    expect(callHandler.handle).not.toHaveBeenCalled();
  });

  it('should execute handler and cache response on cache miss', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue({ ttl: 3600 });
    mockRedis.get.mockResolvedValue(null);

    const status = 201;
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { 'idempotency-key': 'key-abc' },
          method: 'POST',
          path: '/test',
        }),
        getResponse: () => ({ statusCode: status }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    const callHandler: CallHandler = {
      handle: () => of({ id: 'new-123' }),
    };

    const observable = await interceptor.intercept(context, callHandler);
    const result = await lastValueFrom(observable as unknown as Observable<unknown>);

    expect(result).toEqual({ id: 'new-123' });
    expect(mockRedis.get).toHaveBeenCalledWith('idempotency:POST:/test:key-abc');
    expect(mockRedis.set).toHaveBeenCalledWith(
      'idempotency:POST:/test:key-abc',
      JSON.stringify({ statusCode: 201, body: { id: 'new-123' } }),
      'EX',
      3600,
    );
  });
});
