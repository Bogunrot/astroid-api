import { OnEvent } from '@nestjs/event-emitter';
import { DomainEventMap } from './typed-event-emitter.service';

/**
 * Type-safe decorator for listening to domain events.
 * Ensures compile-time type safety for event payload handlers.
 *
 * @example
 * @TypedOnEvent('wallet.created')
 * handleWalletCreated(payload: WalletCreatedPayload) {
 *   console.log('Wallet created:', payload.walletId);
 * }
 */
export function TypedOnEvent<K extends keyof DomainEventMap>(
  event: K,
): MethodDecorator {
  return OnEvent(event);
}
