import { z } from 'zod';
import { PaginationMeta } from '../interfaces/api-response.interface';

/** Page size applied when a list request omits `limit`. */
export const DEFAULT_PAGE_LIMIT = 50;

/** Hard upper bound on `limit`; larger values are rejected with 400. */
export const MAX_PAGE_LIMIT = 200;

/**
 * Standard query parameters supported by every list endpoint.
 *
 * Clients page either by `offset` (row offset, preferred) or by `page`
 * (1-based page number); supplying both is rejected. After parsing, both
 * `offset` and `page` are always populated so services and metadata builders
 * never need to care which one the client used. Negative, non-integer or
 * out-of-range values fail validation and surface as 400 Bad Request.
 */
export const paginationQuerySchema = z
  .object({
    offset: z.coerce.number().int().nonnegative().optional(),
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
    sort: z.string().default('createdAt'),
    order: z.enum(['asc', 'desc']).default('desc'),
    search: z.string().optional(),
    filter: z.string().optional(),
  })
  .refine((query) => query.offset === undefined || query.page === undefined, {
    message: 'Provide either offset or page, not both',
    path: ['offset'],
  })
  .transform((query) => {
    const offset = query.offset ?? ((query.page ?? 1) - 1) * query.limit;
    return { ...query, offset, page: Math.floor(offset / query.limit) + 1 };
  });

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface PrismaPagination {
  skip: number;
  take: number;
  orderBy: Record<string, 'asc' | 'desc'>;
}

/**
 * Translates validated pagination query params into Prisma arguments. The
 * bounds are passed as bound `skip`/`take` values (never interpolated into
 * SQL), and `sort` is restricted to an allow-list of columns.
 */
export function toPrismaPagination(
  query: Pick<PaginationQuery, 'offset' | 'limit' | 'sort' | 'order'>,
  allowedSortFields: string[],
): PrismaPagination {
  const sort = allowedSortFields.includes(query.sort) ? query.sort : 'createdAt';
  return {
    skip: query.offset,
    take: query.limit,
    orderBy: { [sort]: query.order },
  };
}

/** Builds pagination metadata for the response envelope. */
export function buildPaginationMeta(
  total: number,
  query: Pick<PaginationQuery, 'offset' | 'page' | 'limit'>,
): PaginationMeta {
  const { offset, page, limit } = query;
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;
  return {
    offset,
    page,
    limit,
    total,
    totalPages,
    hasNext: offset + limit < total,
    hasPrev: offset > 0,
  };
}
