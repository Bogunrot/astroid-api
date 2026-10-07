import { SetMetadata } from '@nestjs/common';

/** Metadata key read by `AuditLogInterceptor` through the Nest Reflector. */
export const AUDIT_LOG_KEY = 'astroid:auditLog';

/**
 * Per-route audit metadata. Everything is optional: a bare `@AuditLog()` is the
 * common case and lets the interceptor derive the action from the HTTP method
 * and the entity from the controller name.
 */
export interface AuditLogOptions {
  /**
   * Semantic action name stored on the audit row (e.g. `POLICY_OVERRIDE`).
   * Defaults to the HTTP method (`POST`, `PATCH`, …).
   */
  action?: string;
  /**
   * Domain entity stored on the audit row (e.g. `Wallet`). Defaults to the
   * controller name with the `Controller` suffix stripped.
   */
  entity?: string;
}

/**
 * Marks a route (handler or whole controller) as audited.
 *
 * Only decorated routes are persisted by `AuditLogInterceptor`, so read-only
 * traffic and uninteresting mutations never pay the cost of a database write.
 * Sensitive, state-changing endpoints — budget adjustments, policy overrides,
 * key rotations — should always carry this decorator.
 *
 * Combining it with `@SkipAudit()` opts a route back out, which is useful when a
 * whole controller is decorated but one handler must not be logged.
 *
 * @example
 * ```ts
 * @Post('budgets/:id/adjust')
 * @AuditLog({ action: 'BUDGET_ADJUSTED', entity: 'Budget' })
 * async adjustBudget(@Body() dto: AdjustBudgetDto) { ... }
 * ```
 */
export const AuditLog = (options: AuditLogOptions = {}) => SetMetadata(AUDIT_LOG_KEY, options);
