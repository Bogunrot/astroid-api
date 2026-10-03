/**
 * The canonical API response shapes used across every Astroid repo.
 * Success: { success: true, data, meta, requestId }
 * Error:   RFC 9457 problem details, served as `application/problem+json`:
 *          { type, title, status, detail, instance, code, requestId, details? }
 */

export interface ApiMeta {
  [key: string]: unknown;
}

export interface PaginationMeta extends ApiMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface CursorPaginationMeta extends ApiMeta {
  limit: number;
  hasNext: boolean;
  nextCursor: string | null;
}

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  meta: ApiMeta;
  requestId: string;
}

/**
 * Error response body following RFC 9457 (Problem Details for HTTP APIs).
 * `type`, `title`, `status`, `detail` and `instance` are the standard members;
 * `code`, `requestId` and `details` are Astroid extension members.
 */
export interface ProblemDetails {
  /** URI identifying the problem type, e.g. `urn:astroid:problem:not-found`. */
  type: string;
  /** Short summary of the problem type; identical for every occurrence. */
  title: string;
  /** HTTP status code of this occurrence. */
  status: number;
  /** Explanation specific to this occurrence. */
  detail: string;
  /** Path of the request that produced the problem (query string omitted). */
  instance: string;
  /** Machine-readable `ErrorCode`; clients should switch on this. */
  code: string;
  /** Correlation id, also sent as the `x-request-id` header. */
  requestId: string;
  /** Structured context, e.g. field-level validation errors. */
  details?: unknown;
}

/** Media type for {@link ProblemDetails} responses. */
export const PROBLEM_JSON_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

export type ApiResponse<T> = ApiSuccessResponse<T> | ProblemDetails;

/** Marker used by the response interceptor to carry meta out of a service. */
export class Paginated<T> {
  constructor(
    public readonly items: T[],
    public readonly meta: PaginationMeta,
  ) {}
}

export class CursorPaginated<T> {
  constructor(
    public readonly items: T[],
    public readonly meta: CursorPaginationMeta,
  ) {}
}
