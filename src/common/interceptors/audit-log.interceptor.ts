import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';

import { CreateAuditLogData } from '../../modules/audit/audit.repository';
import { AuditService } from '../../modules/audit/audit.service';
import { getClientIp } from '../../utils/ip.util';
import { AUDIT_LOG_KEY, AuditLogOptions } from '../decorators/audit-log.decorator';
import { IS_SKIP_AUDIT_KEY } from '../decorators/skip-audit.decorator';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

/** Value substituted for sensitive fields before an audit payload is persisted. */
export const REDACTED_VALUE = '[REDACTED]';

/**
 * Field-name fragments (case-insensitive) considered sensitive. Matching is
 * intentionally broad so credentials never leak into the audit trail, in line
 * with the SECURITY.md redaction policy.
 */
const SENSITIVE_KEY_FRAGMENTS = [
  'password',
  'passphrase',
  'passkey',
  'token',
  'secret',
  'signature',
  'apikey',
  'privatekey',
  'authorization',
  'mnemonic',
  'seedphrase',
];

/** Returns true when a field name denotes sensitive data (e.g. `apiKey`, `accessToken`). */
export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, '');
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/**
 * Deeply masks sensitive fields in a JSON-shaped value, preserving everything
 * else. Never mutates the input: plain objects and arrays are rebuilt.
 */
export function maskSensitiveData<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => maskSensitiveData(item)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = isSensitiveKey(key) ? REDACTED_VALUE : maskSensitiveData(item);
    }
    return result as T;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Stable SHA-256 fingerprint of a (already sanitized) request payload.
 *
 * The digest lets an operator prove which payload an action carried without
 * duplicating it in the audit trail, and makes tampering detectable: a changed
 * body always yields a different hash.
 */
export function hashPayload(value: unknown): string {
  let serialized: string;
  if (value === undefined) {
    serialized = '';
  } else {
    try {
      serialized = JSON.stringify(value) ?? '';
    } catch {
      // Circular or otherwise non-serializable bodies still get a fingerprint.
      serialized = String(value);
    }
  }
  return createHash('sha256').update(serialized).digest('hex');
}

/** Resolved identity of the principal that triggered the request. */
interface AuditIdentity {
  organizationId: string;
  userId: string | null;
  agentId?: string;
  ipAddress?: string;
}

/**
 * Structured audit interceptor for sensitive agent operations.
 *
 * Persists a permanent, traceable record for every route (handler or the whole
 * controller) decorated with `@AuditLog()`. Undecorated routes — including
 * read-only queries — are passed straight through without touching the database,
 * which is what makes the logging selective and high-performance.
 *
 * Captured per request:
 *   - the actor: human admin user id, or the acting agent id
 *   - HTTP method, route path and client IP
 *   - the payload fingerprint (SHA-256 of the sanitized body)
 *   - the sanitized body itself, with secrets/keys/tokens redacted
 *   - the final response status code and the handler duration in milliseconds
 *
 * The write happens once the response has been fully sent (`finish`), so the
 * recorded status code is the real one — including error statuses set by the
 * global exception filter. Persistence is fire-and-forget: a failure is logged
 * but never breaks the client request.
 */
@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditLogInterceptor.name);

  constructor(
    private readonly auditService: AuditService,
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.getAllAndOverride<AuditLogOptions | undefined>(AUDIT_LOG_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Selective logging: only routes decorated with @AuditLog() are persisted,
    // and an explicit @SkipAudit() always wins.
    if (!options || this.isSkipped(context)) {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<Request & { user?: AuthenticatedUser }>();
    const response = http.getResponse<Response>();

    // Audit rows are scoped to an organization (required FK on AuditLog).
    const organizationId =
      request.user?.organizationId ||
      (request.params?.organizationId as string) ||
      (request.headers['x-organization-id'] as string) ||
      undefined;
    if (!organizationId) {
      this.logger.debug(
        `Skipping @AuditLog() route without an organization context: ${request.path}`,
      );
      return next.handle();
    }

    const identity: AuditIdentity = {
      organizationId,
      userId: request.user?.id || (request.headers['x-user-id'] as string) || null,
      // Same agent-identity resolution chain as AgentTraceInterceptor.
      agentId:
        (request.params?.agentId as string) ||
        (request.body?.agentId as string) ||
        (request.query?.agentId as string) ||
        (request.headers['x-agent-id'] as string) ||
        undefined,
      ipAddress: this.resolveIp(request),
    };

    // Captured before the handler runs so the recorded duration covers the full
    // execution time of the route.
    const startedAt = Date.now();

    response.on('finish', () => {
      void this.persistAudit(
        this.buildAuditData(
          request,
          context,
          identity,
          options,
          response.statusCode,
          Date.now() - startedAt,
        ),
      );
    });

    return next.handle();
  }

  /** True when the route opted out with `@SkipAudit()`. */
  private isSkipped(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(IS_SKIP_AUDIT_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }

  /** Resolves the client IP, honouring `x-forwarded-for` only when proxies are trusted. */
  private resolveIp(request: Request): string | undefined {
    const trustProxy = this.config.get<boolean>('app.trustProxy', false);
    const forwarded = request.headers['x-forwarded-for'] as string | undefined;
    return getClientIp(request.ip ?? '', forwarded, trustProxy) || undefined;
  }

  /** Builds the audit row, storing the masked body, path and actor as `newValue`. */
  private buildAuditData(
    request: Request & { user?: AuthenticatedUser },
    context: ExecutionContext,
    identity: AuditIdentity,
    options: AuditLogOptions,
    statusCode: number,
    durationMs: number,
  ): CreateAuditLogData {
    const body = request.body;
    const maskedBody = body && typeof body === 'object' ? maskSensitiveData(body) : undefined;
    const actor = identity.userId
      ? { type: 'USER' as const, id: identity.userId }
      : identity.agentId
        ? { type: 'AGENT' as const, id: identity.agentId }
        : null;

    const newValue: Prisma.InputJsonValue = {
      path: request.path,
      ...(maskedBody !== undefined ? { body: maskedBody } : {}),
      // A stable fingerprint of the sanitized payload: proves what was sent
      // without persisting the same secrets twice.
      payloadHash: hashPayload(maskedBody),
      // Agent identity is stored here per the existing audit-export convention
      // (the schema has no dedicated agent column).
      ...(identity.agentId ? { agentId: identity.agentId } : {}),
      ...(actor ? { actor } : {}),
      statusCode,
      durationMs,
    };

    return {
      organizationId: identity.organizationId,
      userId: identity.userId,
      action: options.action ?? request.method,
      entity: options.entity ?? this.resolveEntity(context),
      entityId: (request.params?.id as string) ?? null,
      newValue,
      ipAddress: identity.ipAddress,
      device: (request.headers['user-agent'] as string) ?? null,
    };
  }

  /** Derives a domain entity name from the controller, e.g. `PolicyController` -> `Policy`. */
  private resolveEntity(context: ExecutionContext): string {
    const controllerName = context.getClass()?.name;
    return controllerName ? controllerName.replace(/Controller$/, '') : 'Request';
  }

  /** Persists the audit row. Failures are logged but never break the client request. */
  private async persistAudit(data: CreateAuditLogData): Promise<void> {
    try {
      await this.auditService.record(data);
    } catch (error) {
      this.logger.error(
        `Failed to write audit log for ${data.action} ${data.entity}: ${(error as Error).message}`,
      );
    }
  }
}
