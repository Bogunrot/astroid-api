import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Controller, Get, INestApplication, Logger, Query } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  buildPaginationMeta,
  PaginationQuery,
  paginationQuerySchema,
  toPrismaPagination,
} from './pagination';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { Paginated } from '../interfaces/api-response.interface';
import { ResponseInterceptor } from '../interceptors/response.interceptor';
import { AllExceptionsFilter } from '../filters/all-exceptions.filter';

/**
 * End-to-end check of the list-endpoint pagination contract over real HTTP:
 * query parsing (ZodValidationPipe), the Prisma skip/take mapping, the success
 * envelope + X-Total-Count header (ResponseInterceptor) and the 400 path
 * (AllExceptionsFilter). The repository is an in-memory table of 120 rows that
 * honours `skip`/`take` exactly like Prisma's `findMany`.
 */

const ROWS = Array.from({ length: 120 }, (_, i) => ({ id: i + 1 }));

type ListBody = {
  success: boolean;
  data: { id: number }[];
  meta: Record<string, unknown>;
};

@Controller('resources')
class ResourceController {
  @Get()
  list(@Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery) {
    const { skip, take } = toPrismaPagination(query, ['createdAt']);
    return new Paginated(ROWS.slice(skip, skip + take), buildPaginationMeta(ROWS.length, query));
  }
}

describe('List pagination (integration)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({ controllers: [ResourceController] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.listen(0, '127.0.0.1');
    baseUrl = `${await app.getUrl()}/resources`;
  });

  afterAll(async () => {
    await app.close();
  });

  async function get(query = '') {
    const res = await fetch(`${baseUrl}${query}`);
    return { res, body: (await res.json()) as ListBody };
  }

  it('returns the first 50 rows with total metadata and header by default', async () => {
    const { res, body } = await get();

    expect(res.status).toBe(200);
    expect(res.headers.get('x-total-count')).toBe('120');
    expect(body.data).toHaveLength(50);
    expect(body.data[0].id).toBe(1);
    expect(body.meta).toEqual({
      offset: 0,
      page: 1,
      limit: 50,
      total: 120,
      totalPages: 3,
      hasNext: true,
      hasPrev: false,
    });
  });

  it('returns the requested offset/limit slice', async () => {
    const { res, body } = await get('?offset=30&limit=10');

    expect(res.status).toBe(200);
    expect(body.data.map((row) => row.id)).toEqual([
      31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
    ]);
    expect(body.meta).toMatchObject({ offset: 30, limit: 10, hasPrev: true, hasNext: true });
  });

  it('returns a short final slice and no next page at the end', async () => {
    const { body } = await get('?offset=100&limit=50');

    expect(body.data).toHaveLength(20);
    expect(body.data[19].id).toBe(120);
    expect(body.meta.hasNext).toBe(false);
  });

  it('returns an empty slice past the end instead of failing', async () => {
    const { res, body } = await get('?offset=500');

    expect(res.status).toBe(200);
    expect(body.data).toEqual([]);
    expect(res.headers.get('x-total-count')).toBe('120');
  });

  it('allows the maximum limit of 200', async () => {
    const { res, body } = await get('?limit=200');

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(120);
  });

  it.each([
    ['limit above the cap', '?limit=201'],
    ['negative offset', '?offset=-1'],
    ['negative limit', '?limit=-10'],
    ['zero limit', '?limit=0'],
    ['non-numeric limit', '?limit=abc'],
    ['fractional offset', '?offset=2.5'],
    ['offset and page together', '?offset=10&page=2'],
  ])('rejects a %s with 400 Bad Request', async (_label, query) => {
    const { res } = await get(query);

    expect(res.status).toBe(400);
    expect(res.headers.get('x-total-count')).toBeNull();
  });
});
