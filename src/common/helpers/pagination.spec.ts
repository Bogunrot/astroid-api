import { describe, expect, it } from 'vitest';
import {
  buildPaginationMeta,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  paginationQuerySchema,
  toPrismaPagination,
} from './pagination';

describe('paginationQuerySchema', () => {
  it('applies offset 0 and limit 50 when no bounds are supplied', () => {
    const query = paginationQuerySchema.parse({});

    expect(query).toMatchObject({ offset: 0, page: 1, limit: DEFAULT_PAGE_LIMIT });
    expect(DEFAULT_PAGE_LIMIT).toBe(50);
  });

  it('coerces string query values into numbers', () => {
    const query = paginationQuerySchema.parse({ offset: '100', limit: '25' });

    expect(query).toMatchObject({ offset: 100, limit: 25, page: 5 });
  });

  it('derives the offset from a page number', () => {
    const query = paginationQuerySchema.parse({ page: '3', limit: '20' });

    expect(query).toMatchObject({ offset: 40, page: 3, limit: 20 });
  });

  it('accepts a limit equal to the 200 cap', () => {
    expect(MAX_PAGE_LIMIT).toBe(200);
    expect(paginationQuerySchema.parse({ limit: '200' }).limit).toBe(200);
  });

  it.each([
    ['a limit above the cap', { limit: '201' }],
    ['a zero limit', { limit: '0' }],
    ['a negative limit', { limit: '-5' }],
    ['a negative offset', { offset: '-1' }],
    ['a fractional offset', { offset: '1.5' }],
    ['a non-numeric limit', { limit: 'abc' }],
    ['a non-numeric offset', { offset: 'ten' }],
    ['a zero page', { page: '0' }],
  ])('rejects %s', (_label, input) => {
    expect(paginationQuerySchema.safeParse(input).success).toBe(false);
  });

  it('rejects offset and page supplied together', () => {
    const result = paginationQuerySchema.safeParse({ offset: '10', page: '2' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ['offset'],
      message: 'Provide either offset or page, not both',
    });
  });
});

describe('toPrismaPagination', () => {
  it('maps offset and limit onto skip and take', () => {
    const query = paginationQuerySchema.parse({ offset: '120', limit: '40' });

    expect(toPrismaPagination(query, ['createdAt'])).toEqual({
      skip: 120,
      take: 40,
      orderBy: { createdAt: 'desc' },
    });
  });

  it('falls back to createdAt for a sort field outside the allow-list', () => {
    const query = paginationQuerySchema.parse({ sort: 'passwordHash; DROP TABLE users' });

    expect(toPrismaPagination(query, ['name', 'createdAt']).orderBy).toEqual({ createdAt: 'desc' });
  });

  it('keeps an allow-listed sort field and direction', () => {
    const query = paginationQuerySchema.parse({ sort: 'name', order: 'asc' });

    expect(toPrismaPagination(query, ['name', 'createdAt']).orderBy).toEqual({ name: 'asc' });
  });
});

describe('buildPaginationMeta', () => {
  it('reports the slice position and totals', () => {
    const meta = buildPaginationMeta(120, paginationQuerySchema.parse({ offset: '50', limit: '50' }));

    expect(meta).toEqual({
      offset: 50,
      page: 2,
      limit: 50,
      total: 120,
      totalPages: 3,
      hasNext: true,
      hasPrev: true,
    });
  });

  it('has no next slice on the last page', () => {
    const meta = buildPaginationMeta(120, paginationQuerySchema.parse({ offset: '100', limit: '50' }));

    expect(meta.hasNext).toBe(false);
    expect(meta.hasPrev).toBe(true);
  });

  it('computes hasNext/hasPrev from offsets that are not page-aligned', () => {
    const meta = buildPaginationMeta(60, paginationQuerySchema.parse({ offset: '5', limit: '50' }));

    expect(meta).toMatchObject({ offset: 5, page: 1, hasNext: true, hasPrev: true });
  });

  it('handles an empty result set', () => {
    const meta = buildPaginationMeta(0, paginationQuerySchema.parse({}));

    expect(meta).toMatchObject({ total: 0, totalPages: 0, hasNext: false, hasPrev: false });
  });
});
