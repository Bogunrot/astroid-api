import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpException,
  Logger,
  MethodNotAllowedException,
  UnauthorizedException,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';

import { AllExceptionsFilter } from './all-exceptions.filter';
import { ErrorCode } from '../constants/error-codes';
import { DomainException, ValidationException } from '../exceptions/domain.exception';
import { RequestContext } from '../context/request-context';
import { ProblemDetails } from '../interfaces/api-response.interface';
import { ZodValidationException } from '../pipes/zod-validation.pipe';

type MockResponse = {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
};

function buildHost(request: Record<string, unknown> = {}) {
  const response: MockResponse = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
  };
  const req = {
    method: 'POST',
    url: '/api/v1/transactions',
    originalUrl: '/api/v1/transactions',
    headers: {},
    ...request,
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => req }),
  } as unknown as ArgumentsHost;

  return { host, response };
}

/** Reads the problem details body captured by the mocked `response.json`. */
function renderedBody(response: MockResponse): ProblemDetails {
  expect(response.json).toHaveBeenCalledTimes(1);
  return response.json.mock.calls[0][0];
}

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  describe('problem details format', () => {
    it('renders every standard member plus the code and requestId extensions', () => {
      const { host, response } = buildHost({ headers: { 'x-request-id': 'req-1' } });

      filter.catch(new DomainException(ErrorCode.NOT_FOUND, "Agent 'a1' not found"), host);

      expect(renderedBody(response)).toEqual({
        type: 'urn:astroid:problem:not-found',
        title: 'Resource Not Found',
        status: 404,
        detail: "Agent 'a1' not found",
        instance: '/api/v1/transactions',
        code: ErrorCode.NOT_FOUND,
        requestId: 'req-1',
      });
    });

    it('serves the body as application/problem+json', () => {
      const { host, response } = buildHost();

      filter.catch(new Error('boom'), host);

      expect(response.setHeader).toHaveBeenCalledWith(
        'Content-Type',
        'application/problem+json; charset=utf-8',
      );
    });

    it('keeps the status member in sync with the HTTP status', () => {
      const { host, response } = buildHost();

      filter.catch(new DomainException(ErrorCode.WALLET_FROZEN, 'Wallet is frozen'), host);

      expect(response.status).toHaveBeenCalledWith(423);
      expect(renderedBody(response).status).toBe(423);
    });

    it('uses the request path without the query string as instance', () => {
      const { host, response } = buildHost({
        url: '/api/v1/wallets?token=secret',
        originalUrl: '/api/v1/wallets?token=secret',
      });

      filter.catch(new HttpException('Resource not found', 404), host);

      expect(renderedBody(response).instance).toBe('/api/v1/wallets');
    });

    it('omits details when there are none', () => {
      const { host, response } = buildHost();

      filter.catch(new HttpException('Resource not found', 404), host);

      expect(renderedBody(response)).not.toHaveProperty('details');
    });
  });

  describe('validation failures', () => {
    it('renders a ZodValidationException as 400 VALIDATION_ERROR with field details', () => {
      const { host, response } = buildHost();
      const details = [{ path: 'limit', message: 'Number must be less than or equal to 200' }];

      filter.catch(new ZodValidationException('Request validation failed', details), host);

      expect(response.status).toHaveBeenCalledWith(400);
      expect(renderedBody(response)).toMatchObject({
        type: 'urn:astroid:problem:validation-error',
        title: 'Validation Failed',
        status: 400,
        detail: 'Request validation failed',
        code: ErrorCode.VALIDATION_ERROR,
        details,
      });
    });

    it('preserves a domain ValidationException status, code and details', () => {
      const { host, response } = buildHost();

      filter.catch(
        new ValidationException('Request validation failed', [
          { path: 'email', message: 'Invalid email' },
        ]),
        host,
      );

      expect(response.status).toHaveBeenCalledWith(422);
      expect(renderedBody(response)).toMatchObject({
        status: 422,
        code: ErrorCode.VALIDATION_ERROR,
        detail: 'Request validation failed',
        details: [{ path: 'email', message: 'Invalid email' }],
      });
    });

    it('joins class-validator messages into detail and keeps them as details', () => {
      const { host, response } = buildHost();

      filter.catch(
        new BadRequestException(['email must be an email', 'age must be a number']),
        host,
      );

      expect(response.status).toHaveBeenCalledWith(400);
      const body = renderedBody(response);
      expect(body.code).toBe(ErrorCode.BAD_REQUEST);
      expect(body.title).toBe('Bad Request');
      expect(body.detail).toBe('email must be an email, age must be a number');
      expect(body.details).toEqual(['email must be an email', 'age must be a number']);
    });
  });

  describe('authentication and authorization errors', () => {
    it('maps a 401 onto UNAUTHORIZED', () => {
      const { host, response } = buildHost();

      filter.catch(new UnauthorizedException('Invalid or expired token'), host);

      expect(response.status).toHaveBeenCalledWith(401);
      expect(renderedBody(response)).toMatchObject({
        type: 'urn:astroid:problem:unauthorized',
        title: 'Unauthorized',
        status: 401,
        detail: 'Invalid or expired token',
        code: ErrorCode.UNAUTHORIZED,
      });
    });

    it('maps a 403 onto FORBIDDEN', () => {
      const { host, response } = buildHost();

      filter.catch(new ForbiddenException('Insufficient permissions'), host);

      expect(renderedBody(response)).toMatchObject({ status: 403, code: ErrorCode.FORBIDDEN });
    });

    it('keeps specific domain auth codes such as TOKEN_EXPIRED', () => {
      const { host, response } = buildHost();

      filter.catch(new DomainException(ErrorCode.TOKEN_EXPIRED, 'Token has expired'), host);

      expect(renderedBody(response)).toMatchObject({
        type: 'urn:astroid:problem:token-expired',
        title: 'Token Expired',
        status: 401,
      });
    });
  });

  describe('rate limiting (429)', () => {
    it('renders a ThrottlerException as a RATE_LIMITED problem', () => {
      const { host, response } = buildHost();

      filter.catch(new ThrottlerException('Rate limit exceeded'), host);

      expect(response.status).toHaveBeenCalledWith(429);
      expect(renderedBody(response)).toMatchObject({
        type: 'urn:astroid:problem:rate-limited',
        title: 'Too Many Requests',
        status: 429,
        detail: 'Rate limit exceeded',
        code: ErrorCode.RATE_LIMITED,
      });
    });

    it('uses the default throttler message when none is supplied', () => {
      const { host, response } = buildHost();

      filter.catch(new ThrottlerException(), host);

      expect(renderedBody(response).detail).toBe('ThrottlerException: Too Many Requests');
    });
  });

  describe('server faults', () => {
    it('maps unknown errors to a generic 500 without leaking internals', () => {
      const { host, response } = buildHost();

      filter.catch(new Error('connection string postgres://user:pw@db leaked'), host);

      expect(response.status).toHaveBeenCalledWith(500);
      const body = renderedBody(response);
      expect(body).toMatchObject({
        type: 'urn:astroid:problem:internal-error',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred',
        code: ErrorCode.INTERNAL_ERROR,
      });
      expect(JSON.stringify(body)).not.toContain('postgres://');
    });

    it('renders non-Error throwables as 500 without crashing', () => {
      const { host, response } = buildHost();

      filter.catch('a string thrown somewhere', host);

      expect(response.status).toHaveBeenCalledWith(500);
      expect(renderedBody(response).code).toBe(ErrorCode.INTERNAL_ERROR);
    });

    it('logs server faults at error level with the stack', () => {
      const { host } = buildHost();
      const error = new Error('boom');

      filter.catch(error, host);

      expect(Logger.prototype.error).toHaveBeenCalledWith(expect.stringContaining('500'), error.stack);
    });
  });

  describe('statuses without a dedicated error code', () => {
    it('uses about:blank and the HTTP reason phrase', () => {
      const { host, response } = buildHost();

      filter.catch(new MethodNotAllowedException(), host);

      expect(response.status).toHaveBeenCalledWith(405);
      expect(renderedBody(response)).toMatchObject({
        type: 'about:blank',
        title: 'Method Not Allowed',
        status: 405,
      });
    });
  });

  describe('Prisma database errors', () => {
    it('maps a P2002 unique-constraint violation onto 409 CONFLICT', () => {
      const { host, response } = buildHost();
      const error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.22.0',
      });

      filter.catch(error, host);

      expect(response.status).toHaveBeenCalledWith(409);
      expect(renderedBody(response)).toMatchObject({ status: 409, code: ErrorCode.CONFLICT });
    });

    it('maps a P2025 record-not-found error onto 404 NOT_FOUND', () => {
      const { host, response } = buildHost();
      const error = new Prisma.PrismaClientKnownRequestError('Record not found', {
        code: 'P2025',
        clientVersion: '5.22.0',
      });

      filter.catch(error, host);

      expect(response.status).toHaveBeenCalledWith(404);
      expect(renderedBody(response).code).toBe(ErrorCode.NOT_FOUND);
    });

    it('maps other known Prisma request errors onto 400 BAD_REQUEST', () => {
      const { host, response } = buildHost();
      const error = new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', {
        code: 'P2003',
        clientVersion: '5.22.0',
      });

      filter.catch(error, host);

      expect(response.status).toHaveBeenCalledWith(400);
      expect(renderedBody(response).code).toBe(ErrorCode.BAD_REQUEST);
    });
  });

  describe('request id tracking', () => {
    it('propagates the inbound request id so clients can correlate the error', () => {
      const { host, response } = buildHost({ headers: { 'x-request-id': 'req-42' } });

      filter.catch(new ThrottlerException(), host);

      expect(renderedBody(response).requestId).toBe('req-42');
    });

    it('generates a fresh request id when the header is absent', () => {
      const { host, response } = buildHost();

      filter.catch(new Error('boom'), host);

      const { requestId } = renderedBody(response);
      expect(requestId).toMatch(/^req_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(requestId).not.toBe('unknown');
    });

    it('generates distinct request ids for separate error responses', () => {
      const first = buildHost();
      const second = buildHost();

      filter.catch(new Error('boom'), first.host);
      filter.catch(new Error('boom'), second.host);

      expect(renderedBody(first.response).requestId).not.toBe(
        renderedBody(second.response).requestId,
      );
    });

    it('recovers the request id from the ambient RequestContext when the header is missing', () => {
      const { host, response } = buildHost();

      RequestContext.run(
        {
          identity: {
            requestId: 'ctx-req-1',
            correlationId: 'ctx-req-1',
            traceId: 'ctx-req-1',
            method: 'POST',
            path: '/api/v1/transactions',
            url: '/api/v1/transactions',
            ip: null,
            userAgent: null,
            startedAt: Date.now(),
          },
          timings: {},
          data: {},
        },
        () => filter.catch(new Error('boom'), host),
      );

      expect(renderedBody(response).requestId).toBe('ctx-req-1');
    });

    it('prefers the inbound header over the ambient RequestContext', () => {
      const { host, response } = buildHost({ headers: { 'x-request-id': 'header-req-1' } });

      RequestContext.run(
        {
          identity: {
            requestId: 'ctx-req-1',
            correlationId: 'ctx-req-1',
            traceId: 'ctx-req-1',
            method: 'POST',
            path: '/api/v1/transactions',
            url: '/api/v1/transactions',
            ip: null,
            userAgent: null,
            startedAt: Date.now(),
          },
          timings: {},
          data: {},
        },
        () => filter.catch(new Error('boom'), host),
      );

      expect(renderedBody(response).requestId).toBe('header-req-1');
    });
  });
});
