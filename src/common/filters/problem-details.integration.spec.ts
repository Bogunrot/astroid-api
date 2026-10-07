import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  Body,
  CanActivate,
  Controller,
  Get,
  INestApplication,
  Injectable,
  Logger,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { PolicyViolationException } from '../exceptions/domain.exception';

/**
 * Verifies over real HTTP that every error path of the API (validation,
 * authentication, domain rules, unknown routes and unexpected server faults)
 * answers with an RFC 9457 problem details body.
 */

const createItemSchema = z.object({ name: z.string().min(1), amount: z.number().positive() });

@Injectable()
class RejectingAuthGuard implements CanActivate {
  canActivate(): boolean {
    throw new UnauthorizedException('Authentication required');
  }
}

@Controller('items')
class ItemsController {
  @Post()
  create(@Body(new ZodValidationPipe(createItemSchema)) body: z.infer<typeof createItemSchema>) {
    return body;
  }

  @Get('secure')
  @UseGuards(RejectingAuthGuard)
  secure() {
    return { ok: true };
  }

  @Post('transfer')
  transfer() {
    throw new PolicyViolationException('Transfer exceeds the daily limit', { limit: '100' });
  }

  @Get('boom')
  boom() {
    throw new Error('ECONNREFUSED 10.0.0.5:5432');
  }
}

const PROBLEM_KEYS = ['type', 'title', 'status', 'detail', 'instance', 'code', 'requestId'];

describe('Problem details error responses (integration)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [ItemsController],
      providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    await app.listen(0, '127.0.0.1');
    baseUrl = `${await app.getUrl()}/api/v1`;
  });

  afterAll(async () => {
    await app.close();
  });

  async function call(path: string, init: RequestInit = {}) {
    const res = await fetch(`${baseUrl}${path}`, init);
    return { res, body: (await res.json()) as Record<string, unknown> };
  }

  function expectProblem(res: Response, body: Record<string, unknown>, status: number) {
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
    for (const key of PROBLEM_KEYS) {
      expect(body).toHaveProperty(key);
    }
    expect(body.status).toBe(status);
    expect(body).not.toHaveProperty('success');
  }

  it('returns validation failures as 400 problems with field details', async () => {
    const { res, body } = await call('/items?debug=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '', amount: -5 }),
    });

    expectProblem(res, body, 400);
    expect(body).toMatchObject({
      type: 'urn:astroid:problem:validation-error',
      title: 'Validation Failed',
      detail: 'Request validation failed',
      instance: '/api/v1/items',
      code: 'VALIDATION_ERROR',
    });
    expect((body.details as { path: string }[]).map((d) => d.path).sort()).toEqual(['amount', 'name']);
  });

  it('returns authentication errors as 401 problems', async () => {
    const { res, body } = await call('/items/secure');

    expectProblem(res, body, 401);
    expect(body).toMatchObject({
      type: 'urn:astroid:problem:unauthorized',
      title: 'Unauthorized',
      detail: 'Authentication required',
      instance: '/api/v1/items/secure',
    });
  });

  it('returns domain rule violations with their code and details', async () => {
    const { res, body } = await call('/items/transfer', { method: 'POST' });

    expectProblem(res, body, 422);
    expect(body).toMatchObject({
      type: 'urn:astroid:problem:policy-violation',
      title: 'Policy Violation',
      detail: 'Transfer exceeds the daily limit',
      details: { limit: '100' },
    });
  });

  it('maps unhandled exceptions to a 500 problem without leaking internals', async () => {
    const { res, body } = await call('/items/boom');

    expectProblem(res, body, 500);
    expect(body).toMatchObject({
      type: 'urn:astroid:problem:internal-error',
      title: 'Internal Server Error',
      detail: 'An unexpected error occurred',
    });
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
  });

  it('returns unknown routes as 404 problems', async () => {
    const { res, body } = await call('/does-not-exist');

    expectProblem(res, body, 404);
    expect(body).toMatchObject({ code: 'NOT_FOUND', instance: '/api/v1/does-not-exist' });
  });

  it('echoes the inbound request id', async () => {
    const { body } = await call('/items/secure', { headers: { 'x-request-id': 'req-integration-1' } });

    expect(body.requestId).toBe('req-integration-1');
  });
});
