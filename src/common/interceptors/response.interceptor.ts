import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Request } from 'express';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import {
  ApiSuccessResponse,
  CursorPaginated,
  Paginated,
} from '../interfaces/api-response.interface';
import { REQUEST_ID_HEADER } from '../constants/headers';

/**
 * Wraps every successful controller return value in the canonical success
 * envelope. If a handler returns a `Paginated<T>`, its items become `data` and
 * its pagination info becomes `meta`.
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiSuccessResponse<unknown>> {
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiSuccessResponse<unknown>> {
    const request = context.switchToHttp().getRequest<Request>();
    const requestId = (request.headers[REQUEST_ID_HEADER] as string) ?? 'unknown';

    return next.handle().pipe(
      map((payload): ApiSuccessResponse<unknown> => {
        if (payload instanceof Paginated) {
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
