import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { Request } from 'express';
import {
  RequestContext,
  RequestContextData,
  RequestPrincipal,
} from '../context/request-context';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import {
  CORRELATION_ID_HEADER,
  REQUEST_ID_HEADER,
} from '../constants/headers';
import { resolveRequestId } from '../helpers/request-id';

/**
 * Seeds the structured request context (see {@link RequestContext}) at the very
 * start of every HTTP request, entering the AsyncLocalStorage context around
 * the remainder of the request lifecycle.
 *
 * The context is populated with routing metadata, correlation/trace ids and —
 * once authentication has run — the resolved principal (user / organization /
 * agent). Because `RequestContext.run` propagates the store through every async
 * continuation, downstream controllers and services can read a typed snapshot
 * of the request without threading arguments through the call tree.
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { user?: AuthenticatedUser }>();

    const contextData = this.seed(req);

    return new Observable((subscriber) => {
      RequestContext.run(contextData, () => {
        next.handle().subscribe({
          next: (val) => subscriber.next(val),
          error: (err) => subscriber.error(err),
          complete: () => subscriber.complete(),
        });
      });
    });
  }

  private seed(req: Request & { user?: AuthenticatedUser }): RequestContextData {
    const requestId = resolveRequestId(
      RequestContext.getRequestId() ?? req.headers[REQUEST_ID_HEADER],
    );

    const traceId =
      (req.headers[CORRELATION_ID_HEADER] as string | undefined) ??
      requestId;

    const correlationId =
      (req.headers[CORRELATION_ID_HEADER] as string | undefined) ??
      requestId;

    const user = req.user;

    const principal: RequestPrincipal | undefined = user
      ? {
          userId: user.id,
          organizationId: user.organizationId,
          role: user.role,
          authMethod: 'jwt',
        }
      : this.resolveImplicitPrincipal(req);

    const ip =
      (typeof req.headers['x-forwarded-for'] === 'string'
        ? req.headers['x-forwarded-for'].split(',')[0]?.trim()
        : undefined) ??
      req.socket?.remoteAddress ??
      null;

    const userAgent = (req.headers['user-agent'] as string | undefined) ?? null;

    return {
      identity: {
        requestId,
        correlationId,
        traceId,
        method: req.method,
        path: req.path,
        url: req.originalUrl ?? req.url,
        ip,
        userAgent,
        startedAt: Date.now(),
      },
      principal,
      timings: {},
      data: {},
    };
  }

  private resolveImplicitPrincipal(
    req: Request,
  ): RequestPrincipal | undefined {
    const organizationId =
      (req.params?.organizationId as string | undefined) ??
      (req.headers['x-organization-id'] as string | undefined);
    const agentId =
      (req.params?.agentId as string | undefined) ??
      (req.body?.agentId as string | undefined) ??
      (req.query?.agentId as string | undefined) ??
      (req.headers['x-agent-id'] as string | undefined);

    if (!organizationId && !agentId) {
      return undefined;
    }

    return { organizationId, agentId, authMethod: 'service' };
  }
}
