import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { AuditRepository } from './audit.repository';
import { AuditHashService } from './audit-hash.service';
import { AuditListener } from './audit.listener';
import { Queues } from '../../queues/queues.constants';
import { redisConfig } from '../../config/redis.config';
import { AuditCleanupQueue } from './queues/audit-cleanup.queue';

@Global()
@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: redisConfig().host,
        port: redisConfig().port,
        password: redisConfig().password,
        db: redisConfig().db,
      },
    }),
    // The dedicated `audit` queue persists audit entries asynchronously via the
    // AuditWorker (src/workers/audit.worker.ts). Bounded retries with
    // exponential backoff ride out transient database outages without dropping
    // entries; terminal failures land in the dead-letter queue.
    BullModule.registerQueue({
      name: Queues.Audit,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    }),
    BullModule.registerQueue({
      name: Queues.AuditCleanup,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      },
    }),
  ],
  controllers: [AuditController],
  providers: [AuditService, AuditRepository, AuditHashService, AuditListener, AuditCleanupQueue],
  exports: [AuditService],
})
export class AuditModule {}
