import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { AuditService } from './audit.service';
import { DomainEventEnvelope } from '../../events/domain-event.types';
import { RequestContext } from '../../common/context/request-context';

const MAX_AUDIT_EVENT_BYTES = 16_384;
import { DOMAIN_EVENT_ENVELOPE } from '../../events/domain-event.types';

/**
 * Subscribes to every domain event (wildcard) and appends an audit-log row.
 * Decoupled by design: a failure here must never affect the originating
 * transaction, so errors are swallowed and logged.
 */
@Injectable()
export class AuditListener {
  private readonly logger = new Logger(AuditListener.name);

  constructor(private readonly auditService: AuditService) {}

  @OnEvent(DOMAIN_EVENT_ENVELOPE)
  async handleDomainEvent(envelope: DomainEventEnvelope): Promise<void> {
    if (!envelope?.eventId) {
      return;
    }
    try {
      const requestContext = RequestContext.getStore();
      const organizationId = envelope.organizationId ?? requestContext?.principal?.organizationId;
      if (!organizationId) {
        return;
      }
      const correlationId = envelope.correlationId ?? requestContext?.identity.correlationId;
      const value = {
        eventId: envelope.eventId,
        occurredAt: envelope.occurredAt.toISOString(),
        correlationId: correlationId ?? null,
        success: envelope.name !== 'policy.violated' && !envelope.name.endsWith('.failed'),
        payload: envelope.payload,
      };
      const serialized = JSON.stringify(value);
      const newValue = Buffer.byteLength(serialized, 'utf8') > MAX_AUDIT_EVENT_BYTES
        ? {
            eventId: envelope.eventId,
            truncated: true,
            originalBytes: Buffer.byteLength(serialized, 'utf8'),
            preview: serialized.slice(0, MAX_AUDIT_EVENT_BYTES),
          }
        : value;

      await this.auditService.record({
        organizationId,
        userId: envelope.actorId ?? requestContext?.principal?.userId ?? null,
        action: envelope.name,
        entity: envelope.aggregateType,
        entityId: envelope.aggregateId ?? null,
        newValue: newValue as Prisma.InputJsonValue,
        sourceEventId: envelope.eventId,
        requestId: correlationId ?? requestContext?.identity.requestId ?? null,
        ipAddress: requestContext?.identity.ip ?? null,
        createdAt: envelope.occurredAt,
      });
    } catch (error) {
      this.logger.error(`Failed to write audit log for '${envelope.name}': ${(error as Error).message}`);
    }
  }
}
