import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { STATUS_CODES } from 'http';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';
import { ERROR_TITLE, ErrorCode, problemTypeFor } from '../constants/error-codes';
import { DomainException } from '../exceptions/domain.exception';
import {
  PROBLEM_JSON_CONTENT_TYPE,
  ProblemDetails,
} from '../interfaces/api-response.interface';
import { REQUEST_ID_HEADER } from '../constants/headers';
import { RequestContext } from '../context/request-context';

/** An exception reduced to the facts a problem details body is built from. */
interface ResolvedError {
  status: number;
  code: ErrorCode;
  detail: string;
  details?: unknown;
  /**
   * True when the status has no dedicated error code (e.g. 405) and `code`
   * is only the generic fallback; the body then uses `about:blank` and the
   * HTTP reason phrase as RFC 9457 prescribes.
   */
  generic?: boolean;
}

const ERROR_CODES = new Set<string>(Object.values(ErrorCode));

/**
 * Global exception filter. Converts any thrown error into an RFC 9457 problem
 * details body (`application/problem+json`):
 * `{ type, title, status, detail, instance, code, requestId, details? }`.
 * Internal details are never leaked to the client; unexpected errors are
 * logged with the requestId and returned as a generic 500.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = this.resolveRequestId(request);

    const resolved = this.resolve(exception);
    const body = this.toProblem(resolved, request, requestId);

    if (body.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `[${requestId}] ${request.method} ${request.url} -> ${body.status} ${body.code}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(
        `[${requestId}] ${request.method} ${request.url} -> ${body.status} ${body.code}: ${body.detail}`,
      );
    }

    response.setHeader('Content-Type', PROBLEM_JSON_CONTENT_TYPE);
    response.status(body.status).json(body);
  }

  /**
   * Resolves the request id for an error response. The `x-request-id` header
   * (set by `RequestIdMiddleware`) is authoritative; when absent — e.g. an
   * error thrown before the middleware chain ran — the id is recovered from
   * the ambient {@link RequestContext} or freshly generated so every error
   * response still carries a correlatable identifier instead of `unknown`.
   */
  private resolveRequestId(request: Request): string {
    const headerId = request.headers[REQUEST_ID_HEADER] as string | undefined;
    if (headerId && headerId.length > 0) {
      return headerId;
    }
    return RequestContext.getRequestId() ?? `req_${uuidv7()}`;
  }

  private toProblem(error: ResolvedError, request: Request, requestId: string): ProblemDetails {
    const problem: ProblemDetails = {
      type: error.generic ? 'about:blank' : problemTypeFor(error.code),
      title: error.generic
        ? (STATUS_CODES[error.status] ?? ERROR_TITLE[error.code])
        : ERROR_TITLE[error.code],
      status: error.status,
      detail: error.detail,
      instance: this.instanceFor(request),
      code: error.code,
      requestId,
    };
    if (error.details !== undefined) {
      problem.details = error.details;
    }
    return problem;
  }

  /** The request path without its query string, which may carry secrets. */
  private instanceFor(request: Request): string {
    const url = request.originalUrl ?? request.url ?? '';
    return url.split('?')[0];
  }

  private resolve(exception: unknown): ResolvedError {
    if (exception instanceof DomainException) {
      return {
        status: exception.getStatus(),
        code: exception.code,
        detail: exception.message,
        details: exception.details,
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.resolvePrisma(exception);
    }

    if (exception instanceof HttpException) {
      return this.resolveHttp(exception);
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_ERROR,
      detail: 'An unexpected error occurred',
    };
  }

  /**
   * Maps a Nest `HttpException`. A response object carrying a known `code`
   * (e.g. `ZodValidationException`'s `VALIDATION_ERROR`) keeps that code and
   * its `details`; otherwise the code is derived from the status. Arrays of
   * messages (class-validator) are joined into `detail` and kept as `details`.
   */
  private resolveHttp(exception: HttpException): ResolvedError {
    const status = exception.getStatus();
    const payload = exception.getResponse();
    const body =
      typeof payload === 'object' && payload !== null
        ? (payload as { code?: unknown; message?: unknown; details?: unknown })
        : {};

    const rawMessage = typeof payload === 'string' ? payload : (body.message ?? exception.message);
    const messages = Array.isArray(rawMessage) ? rawMessage.map(String) : undefined;
    const detail = messages ? messages.join(', ') : String(rawMessage);

    if (typeof body.code === 'string' && ERROR_CODES.has(body.code)) {
      return {
        status,
        code: body.code as ErrorCode,
        detail,
        details: body.details ?? messages,
      };
    }

    const mapped = this.statusToCode(status);
    return {
      status,
      code: mapped ?? (status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.BAD_REQUEST),
      detail,
      details: messages,
      generic: mapped === undefined,
    };
  }

  private resolvePrisma(exception: Prisma.PrismaClientKnownRequestError): ResolvedError {
    if (exception.code === 'P2025') {
      return { status: HttpStatus.NOT_FOUND, code: ErrorCode.NOT_FOUND, detail: 'Resource not found' };
    }
    if (exception.code === 'P2002') {
      return {
        status: HttpStatus.CONFLICT,
        code: ErrorCode.CONFLICT,
        detail: 'A resource with these unique attributes already exists',
      };
    }
    return {
      status: HttpStatus.BAD_REQUEST,
      code: ErrorCode.BAD_REQUEST,
      detail: 'Database request could not be processed',
    };
  }

  private statusToCode(status: number): ErrorCode | undefined {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ErrorCode.BAD_REQUEST;
      case HttpStatus.NOT_FOUND:
        return ErrorCode.NOT_FOUND;
      case HttpStatus.UNAUTHORIZED:
        return ErrorCode.UNAUTHORIZED;
      case HttpStatus.FORBIDDEN:
        return ErrorCode.FORBIDDEN;
      case HttpStatus.CONFLICT:
        return ErrorCode.CONFLICT;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCode.RATE_LIMITED;
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return ErrorCode.VALIDATION_ERROR;
      case HttpStatus.INTERNAL_SERVER_ERROR:
        return ErrorCode.INTERNAL_ERROR;
      case HttpStatus.NOT_IMPLEMENTED:
        return ErrorCode.NOT_IMPLEMENTED;
      default:
        return undefined;
    }
  }
}
