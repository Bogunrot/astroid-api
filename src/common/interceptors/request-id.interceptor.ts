import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { REQUEST_ID_HEADER } from '../constants/headers';
import { resolveRequestId } from '../helpers/request-id';

/**
 * Global interceptor that ensures every HTTP request carries a stable,
 * cryptographically-secure request identifier throughout its full lifecycle.
 *
 * Execution order (runs first among APP_INTERCEPTORs):
 *   1. Reads the existing `X-Request-ID` header forwarded by the client or an
 *      upstream proxy (e.g. a load balancer, API gateway).
 *   2. Falls back to `crypto.randomUUID()` when the header is absent or empty.
 *   3. Normalises the resolved ID by writing it back onto `request.headers` so
 *      that downstream interceptors (RequestContextInterceptor,
 *      AgentTraceInterceptor, ResponseInterceptor) and `pino-http`'s `genReqId`
 *      all see a consistent value.
 *   4. Attaches the ID to `request.id` for compatibility with frameworks and
 *      middleware that read the Express `id` property.
 *   5. Sets the `X-Request-ID` response header so clients and debugging tools
 *      can correlate a response with the originating request.
 *   6. Emits a structured log entry on request start and on response completion,
 *      carrying `{ requestId, method, path }` for end-to-end distributed
 *      tracing across controllers, services and background jobs.
 *
 * This interceptor intentionally performs no async work and injects no services
 * so it can be instantiated as a plain class without a DI container (important
 * for unit tests and for being wired as the very first APP_INTERCEPTOR).
 */
@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RequestIdInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { id?: string }>();
    const response = http.getResponse<Response>();

    // 1. Preserve a valid incoming header; replace missing or invalid values.
    const incoming = request.headers[REQUEST_ID_HEADER] as string | undefined;
    const requestId = resolveRequestId(incoming);

    // 2. Normalise — stamp the resolved ID back onto the request headers so
    //    every downstream consumer reads the same value regardless of whether
    //    the client supplied one.
    request.headers[REQUEST_ID_HEADER] = requestId;

    // 3. Attach to `request.id` for Express-ecosystem compatibility.
    request.id = requestId;

    // 4. Echo onto the response immediately (before the handler runs) so the
    //    header is present even when the handler throws synchronously.
    response.setHeader(REQUEST_ID_HEADER, requestId);

    // 5. Structured log on request entry.
    this.logger.log({
      message: 'Request received',
      requestId,
      method: request.method,
      path: request.path,
    });

    return next.handle().pipe(
      // 6. Structured log on response completion (success and error alike).
      tap({
        next: () => {
          this.logger.log({
            message: 'Request completed',
            requestId,
            method: request.method,
            path: request.path,
            statusCode: response.statusCode,
          });
        },
        error: (err: unknown) => {
          this.logger.warn({
            message: 'Request errored',
            requestId,
            method: request.method,
            path: request.path,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      }),
    );
  }
}
