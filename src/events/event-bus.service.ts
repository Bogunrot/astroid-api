import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { DomainEventNameType } from './event-names';
import { DomainEventEnvelope } from './domain-event.types';
import { TypedEventEmitter, DomainEventMap } from './typed-event-emitter.service';
import { RequestContext } from '../common/context/request-context';
import { resolveRequestId } from '../common/helpers/request-id';

export interface EmitOptions {
  organizationId?: string;
  aggregateType: string;
  aggregateId?: string;
  actorId?: string;
  requestId?: string;
  correlationId?: string;
  /** When false, the event is broadcast but NOT written to the ledger. */
  persist?: boolean;
}

/**
 * Central publisher for domain events. Every emit:
 *   1. persists an immutable row to the append-only `domain_events` ledger
 *      (the event-sourcing / immutable event ledger enhancement), and
 *   2. broadcasts in-process via TypedEventEmitter for type-safe event dispatch
 *      so audit, notifications, analytics and webhook subscribers can react independently.
 *
 * A failure in a subscriber must never roll back the originating operation, so
 * broadcasting is fire-and-forget and ledger writes are best-effort logged.
 */
@Injectable()
export class EventBusService {
  private readonly logger = new Logger(EventBusService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly typedEmitter: TypedEventEmitter,
  ) {}

  async emit<K extends keyof DomainEventMap>(
    name: K,
    payload: DomainEventMap[K],
    options: EmitOptions,
  ): Promise<void> {
    const requestId = options.requestId ?? RequestContext.getRequestId() ?? resolveRequestId(undefined);
    const correlationId = options.correlationId ?? RequestContext.getCorrelationId() ?? requestId;
    const metadata = {
      requestId,
      correlationId,
      traceId: RequestContext.getTraceId() ?? correlationId,
    };
    const envelope: DomainEventEnvelope<Record<string, unknown>> = {
      eventId: randomUUID(),
      name: name as unknown as DomainEventNameType,
      organizationId: options.organizationId,
      aggregateType: options.aggregateType,
      aggregateId: options.aggregateId,
      actorId: options.actorId,
      requestId,
      correlationId,
      metadata,
      payload: payload as unknown as Record<string, unknown>,
      occurredAt: new Date(),
    };

    if (options.persist !== false) {
      await this.persist(envelope);
    }

    // Broadcast synchronously in-process using typed emitter for type safety.
    // Subscribers isolate their own errors.
    this.typedEmitter.emit(name, payload, metadata);
    this.typedEmitter.emitEnvelope(envelope);
  }

  private async persist(envelope: DomainEventEnvelope): Promise<void> {
    try {
      await this.prisma.domainEvent.create({
        data: {
          id: envelope.eventId,
          organizationId: envelope.organizationId ?? null,
          name: envelope.name,
          aggregateType: envelope.aggregateType,
          aggregateId: envelope.aggregateId ?? null,
          actorId: envelope.actorId ?? null,
          payload: envelope.payload as object,
          occurredAt: envelope.occurredAt,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to persist domain event '${envelope.name}': ${(error as Error).message}`,
      );
    }
  }
}
