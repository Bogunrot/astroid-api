import { Global, Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { EventBusService } from './event-bus.service';
import { TypedEventEmitter } from './typed-event-emitter.service';

/**
 * Global event bus module. Wraps `@nestjs/event-emitter` and exposes the
 * EventBusService (emit + persist to the immutable ledger) and TypedEventEmitter
 * (type-safe event emission) to all modules.
 */
@Global()
@Module({
  imports: [
    EventEmitterModule.forRoot({
      wildcard: true,
      delimiter: '.',
      maxListeners: 50,
      verboseMemoryLeak: false,
    }),
  ],
  providers: [EventBusService, TypedEventEmitter],
  exports: [EventBusService, TypedEventEmitter],
})
export class EventsModule {}
