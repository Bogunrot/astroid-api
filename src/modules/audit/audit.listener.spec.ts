import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditListener } from './audit.listener';
import { AuditService } from './audit.service';
import { DomainEventEnvelope } from '../../events/domain-event.types';

describe('AuditListener', () => {
  let listener: AuditListener;
  let auditService: { record: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    auditService = { record: vi.fn().mockResolvedValue(undefined) };
    listener = new AuditListener(auditService as unknown as AuditService);
  });

  it('persists event identity, actor, timestamp, correlation, and outcome', async () => {
    const occurredAt = new Date('2026-09-28T12:00:00.000Z');
    const envelope: DomainEventEnvelope = {
      eventId: 'event-1',
      name: 'policy.violated',
      organizationId: 'org-1',
      actorId: 'user-1',
      aggregateType: 'agent',
      aggregateId: 'agent-1',
      correlationId: 'request-1',
      occurredAt,
      payload: { violation: 'daily-limit' },
    };

    await listener.handleDomainEvent(envelope);

    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        userId: 'user-1',
        action: 'policy.violated',
        entity: 'agent',
        entityId: 'agent-1',
        sourceEventId: 'event-1',
        requestId: 'request-1',
        createdAt: occurredAt,
        newValue: expect.objectContaining({
          eventId: 'event-1',
          success: false,
          payload: { violation: 'daily-limit' },
        }),
      }),
    );
  });

  it('bounds large event payloads before persisting', async () => {
    const envelope: DomainEventEnvelope = {
      eventId: 'event-large',
      name: 'transaction.created',
      organizationId: 'org-1',
      aggregateType: 'transaction',
      occurredAt: new Date(),
      payload: { detail: 'x'.repeat(20_000) },
    };

    await listener.handleDomainEvent(envelope);

    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        newValue: expect.objectContaining({ eventId: 'event-large', truncated: true }),
      }),
    );
  });
});