import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WebhookController } from './webhook.controller';
import { WebhookIngressController } from './webhook-ingress.controller';
import { WebhookIngressService } from './webhook-ingress.service';
import { WebhookService } from './webhook.service';
import { WebhookRepository } from './webhook.repository';
import { WebhookDispatcher } from './webhook.dispatcher';
import { WebhookDeliveryService } from './services/webhook-delivery.service';
import { WebhookCircuitBreakerService } from './services/webhook-circuit-breaker.service';
import { WebhooksProcessor } from './webhooks.processor';
import { Queues } from '../../queues/queues.constants';
import { redisConfig } from '../../config/redis.config';
import { webhookBackoffStrategy } from '../../utils/backoff.util';
import { MetricsModule } from '../metrics/metrics.module';
import { RawBodyMiddleware } from '../../common/middleware/raw-body.middleware';
import { WebhookSignatureGuard } from '../../common/guards/webhook-signature.guard';
import { SlidingWindowThrottlerGuard } from '../../common/guards/sliding-window-throttler.guard';
import type { RegisterQueueOptions } from '@nestjs/bullmq';

/**
 * Webhooks module. The dispatcher listens to domain events and queues
 * the curated WEBHOOK_EVENTS set to subscribed external endpoints via BullMQ.
 *
 * Uses a custom backoffStrategy with randomized jitter (20% of base delay)
 * to prevent thundering herd problems when multiple webhook deliveries
 * are retried simultaneously.
 */
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
    BullModule.registerQueue({
      name: Queues.Webhooks,
      defaultJobOptions: {
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: { count: 1000 },
        removeOnFail: { age: 24 * 3600 },
      },
      // BullMQ reads queue.opts.settings.backoffStrategy at retry time.
      // The AdvancedOptions type is not fully exposed by @nestjs/bullmq, so we
      // cast to include the backoffStrategy field that BullMQ supports at runtime.
      settings: {
        backoffStrategy: webhookBackoffStrategy,
      } as RegisterQueueOptions['settings'],
    }),
    MetricsModule,
  ],
  controllers: [WebhookController, WebhookIngressController],
  providers: [
    WebhookService,
    WebhookRepository,
    WebhookDispatcher,
    WebhookDeliveryService,
    WebhookCircuitBreakerService,
    WebhooksProcessor,
    WebhookIngressService,
    WebhookSignatureGuard,
    SlidingWindowThrottlerGuard,
  ],
  exports: [WebhookService, WebhookCircuitBreakerService],
})
export class WebhookModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(RawBodyMiddleware)
      .forRoutes({ path: 'webhooks/receive', method: RequestMethod.POST });
  }
}
