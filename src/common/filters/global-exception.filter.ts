/**
 * GlobalExceptionFilter — the platform-wide exception filter for Astroid.
 *
 * This module is the canonical entry-point referenced by `AppModule` and any
 * consumer that needs the filter class by its descriptive name.  The full
 * implementation lives in `AllExceptionsFilter` (same folder) and is re-
 * exported here under the `GlobalExceptionFilter` name so the acceptance
 * criterion ("Create GlobalExceptionFilter in global-exception.filter.ts") is
 * met without duplicating the logic.
 *
 * Behaviour summary:
 *  • `Prisma.PrismaClientKnownRequestError`
 *      P2002 (unique constraint)  → 409 CONFLICT
 *      P2025 (record not found)   → 404 NOT_FOUND
 *      other known request errors → 400 BAD_REQUEST
 *  • `DomainException` subclasses → preserves `.code`, `.details`, status
 *  • `HttpException` (Nest built-ins, Throttler, ZodValidation, class-validator
 *    arrays, …)                   → maps status → ErrorCode; keeps structured
 *                                   details when present
 *  • Unknown throwables           → 500 INTERNAL_ERROR, no internals leaked
 *
 * Every error response follows RFC 9457 (Problem Details for HTTP APIs) and is
 * served as `application/problem+json`:
 *   { type, title, status, detail, instance, code, requestId, details? }
 */
export { AllExceptionsFilter as GlobalExceptionFilter } from './all-exceptions.filter';
