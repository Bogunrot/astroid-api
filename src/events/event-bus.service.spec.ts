import { describe, expect, it, vi } from 'vitest';
import { RequestContext } from '../common/context/request-context';
import { EventBusService } from './event-bus.service';
import { PrismaService } from '../database/prisma.service';
import { TypedEventEmitter } from './typed-event-emitter.service';

function context(requestId: string) {
  return {
    identity: {
      requestId,
      correlationId: `corr-${requestId}`,
      traceId: `trace-${requestId}`,
      method: 'POST',
      path: '/wallets',
      url: '/wallets',
      ip: null,
      userAgent: null,
      startedAt: Date.now(),
    },
    timings: {},
    data: {},
  };
}

describe('EventBusService correlation metadata', () => {
  it('passes request identity as typed metadata without changing the event payload', async () => {
    const emit = vi.fn();
    const emitEnvelope = vi.fn();
    const service = new EventBusService(
      { domainEvent: { create: vi.fn() } } as unknown as PrismaService,
      { emit, emitEnvelope } as unknown as TypedEventEmitter,
    );
    const payload = { walletId: 'wallet-1' };

    await RequestContext.run(context('req-123'), () =>
      service.emit('wallet.created', payload, { aggregateType: 'Wallet', persist: false }),
    );

    expect(emit).toHaveBeenCalledWith('wallet.created', payload, {
      requestId: 'req-123',
      correlationId: 'corr-req-123',
      traceId: 'trace-req-123',
    });
    expect(emitEnvelope).toHaveBeenCalledWith(expect.objectContaining({
      eventId: expect.any(String),
      requestId: 'req-123',
      correlationId: 'corr-req-123',
      payload,
    }));
  });

  it('generates request correlation metadata for internal events', async () => {
    const emit = vi.fn();
    const emitEnvelope = vi.fn();
    const service = new EventBusService(
      { domainEvent: { create: vi.fn() } } as unknown as PrismaService,
      { emit, emitEnvelope } as unknown as TypedEventEmitter,
    );

    await service.emit('wallet.created', { walletId: 'wallet-1' }, {
      aggregateType: 'Wallet',
      persist: false,
    });

    const metadata = emit.mock.calls[0][2];
    expect(metadata.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(metadata.correlationId).toBe(metadata.requestId);
  });
});