import { describe, it, expect } from 'vitest';
import { TypedOnEvent } from './typed-event-listener.decorator';

describe('TypedOnEvent decorator', () => {
  it('should return a decorator function', () => {
    const decorator = TypedOnEvent('wallet.created');
    expect(typeof decorator).toBe('function');
  });

  it('should be usable as a method decorator', () => {
    const decorator = TypedOnEvent('wallet.created');
    const target = {};
    const propertyKey = 'handleWalletCreated';
    const descriptor = {
      value: () => {},
    };

    // The decorator should execute without errors
    expect(() => {
      decorator(target, propertyKey, descriptor);
    }).not.toThrow();
  });

  it('should work with different event names', () => {
    const events = [
      'wallet.created',
      'agent.registered',
      'policy.evaluated',
      'budget.exceeded',
      'transaction.completed',
    ];

    events.forEach((event) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const decorator = TypedOnEvent(event as any);
      expect(typeof decorator).toBe('function');
    });
  });
});
