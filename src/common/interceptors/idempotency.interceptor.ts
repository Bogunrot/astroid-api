import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import Redis from 'ioredis';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { IDEMPOTENCY_KEY_HEADER } from '../constants/headers';
import { IDEMPOTENT_KEY, IdempotentOptions } from '../decorators/idempotent.decorator';

interface CachedResponse {
  statusCode: number;
  body: unknown;
  headers?: Record<string, string>;
}

/**
 * Interceptor that handles idempotency for state-mutating requests.
 * Checks Redis for an existing response cached under the request's idempotency key.
 * If found, returns the cached response. If not, executes the handler and caches the response.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly defaultTtl = 86400; // 24 hours

  constructor(
    private readonly reflector: Reflector,
    @Optional() @Inject('REDIS_CLIENT') private readonly redisClient?: Redis,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const options = this.reflector.getAllAndOverride<IdempotentOptions | undefined>(
      IDEMPOTENT_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!options) {
      return next.handle();
    }

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const idempotencyKey =
      (req.headers[IDEMPOTENCY_KEY_HEADER] as string) ||
      (req.headers['idempotency-key'] as string);

    if (!idempotencyKey) {
      return next.handle();
    }

    if (!this.redisClient) {
      // Fallback if Redis is not configured or injected
      return next.handle();
    }

    const cacheKey = `idempotency:${req.method}:${req.path}:${idempotencyKey}`;

    const cachedRaw = await this.redisClient.get(cacheKey);
    if (cachedRaw) {
      try {
        const cached: CachedResponse = JSON.parse(cachedRaw);
        res.status(cached.statusCode);
        if (cached.headers) {
          for (const [key, value] of Object.entries(cached.headers)) {
            res.setHeader(key, value);
          }
        }
        return of(cached.body);
      } catch {
        // If parsing fails, proceed with normal execution
      }
    }

    const ttl = options.ttl ?? this.defaultTtl;

    return next.handle().pipe(
      tap(async (responseBody) => {
        try {
          const statusCode = res.statusCode || 200;
          const payload: CachedResponse = {
            statusCode,
            body: responseBody,
          };
          await this.redisClient?.set(cacheKey, JSON.stringify(payload), 'EX', ttl);
        } catch {
          // Ignore cache write errors to prevent failing the request
        }
      }),
    ) as unknown as Observable<unknown>;
  }
}
