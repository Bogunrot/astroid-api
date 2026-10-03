import { Module } from '@nestjs/common';
import { DeadLetterController } from './dead-letter.controller';
import { DeadLetterService } from './dead-letter.service';
import { QueueFailureListener } from '../../queues/queue-failure-listener';

/**
 * Dead-letter queue (DLQ) module. Two collaborators, one responsibility each:
 *   - `QueueFailureListener` observes every BullMQ queue and is the single owner
 *     of structured failure logging (`failed` + `stalled`) and DLQ routing.
 *   - `DeadLetterService` persists terminal failures to the append-only
 *     domain-event ledger and exposes the operator re-drive/purge actions.
 */
@Module({
  controllers: [DeadLetterController],
  providers: [QueueFailureListener, DeadLetterService],
  exports: [QueueFailureListener, DeadLetterService],
})
export class DeadLetterModule {}