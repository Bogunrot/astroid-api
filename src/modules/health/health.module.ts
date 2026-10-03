import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController, QueuesHealthController } from './health.controller';
import { PrismaHealthIndicator } from './indicators/prisma.health';
import { RedisHealthIndicator } from './indicators/redis.health';
import { StellarHealthIndicator } from './indicators/stellar.health';
import { DatabaseMigrationHealthIndicator } from './indicators/database-migration.health';
import { BullMQHealthIndicator } from './indicators/bullmq.health';
import { DatabaseModule } from '../../database/database.module';

@Module({
  // TerminusModule supplies `HealthCheckService` and the indicator base class
  // used by PrismaHealthIndicator.
  imports: [DatabaseModule, TerminusModule],
  controllers: [HealthController, QueuesHealthController],
  providers: [
    PrismaHealthIndicator,
    RedisHealthIndicator,
    StellarHealthIndicator,
    DatabaseMigrationHealthIndicator,
    BullMQHealthIndicator,
  ],
  exports: [
    PrismaHealthIndicator,
    RedisHealthIndicator,
    StellarHealthIndicator,
    DatabaseMigrationHealthIndicator,
    BullMQHealthIndicator,
  ],
})
export class HealthModule {}
