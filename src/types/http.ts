import type { Request } from 'express';
import type { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import type { ProblemDetails } from '../common/interfaces/api-response.interface';

/**
 * Express request after authentication middleware has populated the principal.
 * Controllers use this (via param decorators) instead of reaching into headers.
 */
export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
  requestId: string;
  organizationId: string;
}

/**
 * The standard success envelope returned by every endpoint (PRD Doc 5). Built
 * by the response interceptor; controllers return plain payloads.
 */
export interface ApiSuccessEnvelope<T> {
  success: true;
  data: T;
  meta?: {
    offset?: number;
    page?: number;
    limit?: number;
    total?: number;
    totalPages?: number;
    [k: string]: unknown;
  };
  requestId: string;
}

/**
 * The standard failure body: RFC 9457 problem details whose `code` extension
 * is a machine-readable ErrorCode.
 */
export type ApiErrorEnvelope = ProblemDetails;
