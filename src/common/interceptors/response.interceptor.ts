import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import {
  ApiSuccessResponse,
  CursorPaginated,
  Paginated,
} from '../interfaces/api-response.interface';
import { REQUEST_ID_HEADER, TOTAL_COUNT_HEADER } from '../constants/headers';

/**
 * Wraps every successful controller return value in the canonical success
 * envelope. If a handler returns a `Paginated<T>`, its items become `data`, its
 * pagination info becomes `meta`, and the total row count is also exposed via
 * the `X-Total-Count` header for clients that page from headers.
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiSuccessResponse<unknown>> {
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiSuccessResponse<unknown>> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const requestId = (request.headers[REQUEST_ID_HEADER] as string) ?? 'unknown';

    return next.handle().pipe(
      map((payload): ApiSuccessResponse<unknown> => {
        if (payload instanceof Paginated) {
          http.getResponse<Response>().setHeader(TOTAL_COUNT_HEADER, String(payload.meta.total));
          return { success: true, data: payload.items, meta: payload.meta, requestId };
        }
        if (payload instanceof CursorPaginated) {
          return { success: true, data: payload.items, meta: payload.meta, requestId };
        }
        return { success: true, data: payload ?? null, meta: {}, requestId };
      }),
    );
  }
}
