import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TypedEventEmitter, DomainEventMap } from './typed-event-emitter.service';
import { EventEmitter2 } from '@nestjs/event-emitter';

describe('TypedEventEmitter', () => {
  let typedEmitter: TypedEventEmitter;
  let eventEmitter: EventEmitter2;

  beforeEach(() => {
    eventEmitter = new EventEmitter2();
    typedEmitter = new TypedEventEmitter(eventEmitter);
  });

  describe('emit', () => {
    it('emits typed event with correct payload', () => {
      const handler = vi.fn();
      eventEmitter.on('wallet.created', handler);

      const payload: DomainEventMap['wallet.created'] = {
        walletId: 'wallet-123',
        stellarAddress: 'GABC...',
        walletType: 'standard',
      };

      const result = typedEmitter.emit('wallet.created', payload);

      expect(result).toBe(true);
      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('returns false when no listeners are registered', () => {
      const payload: DomainEventMap['wallet.created'] = {
        walletId: 'wallet-123',
        stellarAddress: 'GABC...',
        walletType: 'standard',
      };

      const result = typedEmitter.emit('wallet.created', payload);

      expect(result).toBe(false);
    });

    it('forwards typed metadata as a separate event argument', () => {
      const handler = vi.fn();
      const payload: DomainEventMap['wallet.created'] = { walletId: 'wallet-123' };
      const metadata = { requestId: 'req-1', correlationId: 'corr-1' };
      eventEmitter.on('wallet.created', handler);

      typedEmitter.emit('wallet.created', payload, metadata);

      expect(handler).toHaveBeenCalledWith(payload, metadata);
    });

    it('enforces type safety at compile time', () => {
      const payload: DomainEventMap['agent.registered'] = {
        agentId: 'agent-123',
        name: 'Test Agent',
        role: 'worker',
      };

      const handler = vi.fn();
      eventEmitter.on('agent.registered', handler);

      typedEmitter.emit('agent.registered', payload);

      expect(handler).toHaveBeenCalledWith(payload);
    });
  });

  describe('on', () => {
    it('registers typed event listener', () => {
      const handler = vi.fn();
      const payload: DomainEventMap['wallet.created'] = {
        walletId: 'wallet-123',
        stellarAddress: 'GABC...',
        walletType: 'standard',
      };

      typedEmitter.on('wallet.created', handler);
      eventEmitter.emit('wallet.created', payload);

      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('supports async handlers', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const payload: DomainEventMap['wallet.created'] = {
        walletId: 'wallet-123',
        stellarAddress: 'GABC...',
        walletType: 'standard',
      };

      typedEmitter.on('wallet.created', handler);
      eventEmitter.emit('wallet.created', payload);

      await expect(handler()).resolves.toBeUndefined();
      expect(handler).toHaveBeenCalledWith(payload);
    });
  });

  describe('once', () => {
    it('registers one-time typed event listener', () => {
      const handler = vi.fn();
      const payload: DomainEventMap['wallet.created'] = {
        walletId: 'wallet-123',
        stellarAddress: 'GABC...',
        walletType: 'standard',
      };

      typedEmitter.once('wallet.created', handler);
      eventEmitter.emit('wallet.created', payload);
      eventEmitter.emit('wallet.created', payload);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(payload);
    });
  });

  describe('off', () => {
    it('removes specific typed event listener', () => {
      const handler = vi.fn();
      const payload: DomainEventMap['wallet.created'] = {
        walletId: 'wallet-123',
        stellarAddress: 'GABC...',
        walletType: 'standard',
      };

      typedEmitter.on('wallet.created', handler);
      eventEmitter.emit('wallet.created', payload);
      expect(handler).toHaveBeenCalledTimes(1);

      typedEmitter.off('wallet.created', handler);
      eventEmitter.emit('wallet.created', payload);
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('removeAllListeners', () => {
    it('removes all listeners for specific event', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const payload: DomainEventMap['wallet.created'] = {
        walletId: 'wallet-123',
        stellarAddress: 'GABC...',
        walletType: 'standard',
      };

      typedEmitter.on('wallet.created', handler1);
      typedEmitter.on('wallet.created', handler2);
      eventEmitter.emit('wallet.created', payload);
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);

      typedEmitter.removeAllListeners('wallet.created');
      eventEmitter.emit('wallet.created', payload);
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('removes all listeners when no event specified', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const payload1: DomainEventMap['wallet.created'] = {
        walletId: 'wallet-123',
        stellarAddress: 'GABC...',
        walletType: 'standard',
      };
      const payload2: DomainEventMap['agent.registered'] = {
        agentId: 'agent-123',
        name: 'Test Agent',
        role: 'worker',
      };

      typedEmitter.on('wallet.created', handler1);
      typedEmitter.on('agent.registered', handler2);
      eventEmitter.emit('wallet.created', payload1);
      eventEmitter.emit('agent.registered', payload2);
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);

      typedEmitter.removeAllListeners();
      eventEmitter.emit('wallet.created', payload1);
      eventEmitter.emit('agent.registered', payload2);
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });
  });
});
