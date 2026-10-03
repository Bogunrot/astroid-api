import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { Redis } from 'ioredis';

import { AppConfigModule } from './config';
import { createThrottlerOptions, ThrottlerConfig } from './config/throttler.config';
import { RedisThrottlerStorage } from './common/throttler/redis-throttler.storage';
import { DatabaseModule } from './database/database.module';
import { EventsModule } from './events/events.module';
import { LocksModule } from './common/locks/locks.module';
import { REDIS_CLIENT } from './common/locks/locks.constants';
import { EncryptionModule } from './common/encryption/encryption.module';
import { RequestIdMiddleware } from './middleware/request-id.middleware';
import { StructuredRequestLoggingMiddleware } from './middleware/structured-request-logging.middleware';
import { REQUEST_ID_HEADER } from './common/constants/headers';

import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { ScopesGuard } from './common/guards/scopes.guard';
import { AstroidThrottlerGuard } from './common/guards/throttler.guard';
import { PublicRateLimitGuard } from './common/guards/public-rate-limit.guard';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { AgentPolicyGuard } from './modules/policies/guards/agent-policy.guard';

import { AuthModule } from './modules/auth/auth.module';
import { OrganizationModule } from './modules/organizations/organization.module';
import { AgentModule } from './modules/agents/agent.module';
import { WalletModule } from './modules/wallets/wallet.module';
import { PolicyModule } from './modules/policies/policy.module';
import { RiskModule } from './modules/risk/risk.module';
import { BudgetModule } from './modules/budgets/budget.module';
import { TransactionModule } from './modules/transactions/transaction.module';
import { ApprovalModule } from './modules/approvals/approval.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { NotificationModule } from './modules/notifications/notification.module';
import { DeveloperModule } from './modules/developer/developer.module';
import { MemoryModule } from './modules/memory/memory.module';
import { WebhookModule } from './modules/webhooks/webhook.module';
import { StellarModule } from './modules/stellar/stellar.module';
import { AuditModule } from './modules/audit/audit.module';
import { AiModule } from './modules/ai/ai.module';
import { HealthModule } from './modules/health/health.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { AdminModule } from './modules/admin/admin.module';
import { RequestMetricsMiddleware } from './modules/metrics/metrics.middleware';
import { DeadLetterModule } from './modules/dead-letter/dead-letter.module';
import { AgentTraceInterceptor } from './common/interceptors/agent-trace.interceptor';
import { RequestContextInterceptor } from './common/interceptors/request-context.interceptor';
import { AuditLogInterceptor } from './common/interceptors/audit-log.interceptor';
import { MetricsInterceptor } from './common/interceptors/metrics.interceptor';
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor';

/**
 * Root application module. Wires the global infrastructure (config, logging,
 * database, events, rate limiting) and every domain module, then registers the
 * cross-cutting guards, interceptor and exception filter that enforce the
 * platform's contract on every request:
 *   - PublicRateLimitGuard: per-IP sliding-window limit on @Public() routes and
 *                          /<prefix>/public/*, shared via Redis (runs first so
 *                          bursts are rejected before any other work)
 *   - JwtAuthGuard      : authentication on all routes except @Public()
 *   - RolesGuard        : RBAC on routes decorated with @Roles()
 *   - ScopesGuard       : Fine-grained permission scopes for API keys & agents
 *   - ThrottlerGuard    : per-organization / per-IP rate limiting, shared via Redis
 *   - ResponseInterceptor: wraps every result in the success envelope
 *   - AuditLogInterceptor: persists masked mutation requests to the audit trail
 *   - MetricsInterceptor: records Prometheus metrics for HTTP requests
 *   - AllExceptionsFilter: converts every error into the error envelope
 */
@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRoot({
      pinoHttp: {
        // Reuse the request id set by RequestIdMiddleware for correlated logs.
        genReqId: (req) => (req.headers[REQUEST_ID_HEADER] as string) ?? undefined,
        // Never log Authorization headers, cookies or API keys.
        redact: {
          paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]'],
          remove: true,
        },
        autoLogging: false,
      },
    }),
    // Three rate-limit tiers, all driven by THROTTLE_* env vars (see
    // config/throttler.config.ts). Every route is subject to all named
    // throttlers, but AstroidThrottlerGuard enforces only the one matching the
    // route's @ThrottleTierDecorator tier ('api' default, 'auth' for the
    // sensitive auth endpoints), and AgentThrottlerGuard (applied to the
    // agent-facing controllers) enforces the 'agent' tier keyed by acting agent.
    // Counters live in Redis so every replica behind the load balancer enforces
    // the same budget.
    ThrottlerModule.forRootAsync({
      imports: [LocksModule],
      inject: [ConfigService, REDIS_CLIENT],
      useFactory: (config: ConfigService, redis: Redis) =>
        createThrottlerOptions(
          config.getOrThrow<ThrottlerConfig>('throttler'),
          new RedisThrottlerStorage(redis),
        ),
    }),

    DatabaseModule,
    EventsModule,
    LocksModule,
    EncryptionModule,

    // Domain modules
    AuthModule,
    OrganizationModule,
    AgentModule,
    WalletModule,
    PolicyModule,
    RiskModule,
    BudgetModule,
    TransactionModule,
    ApprovalModule,
    AnalyticsModule,
    NotificationModule,
    DeveloperModule,
    MemoryModule,
    WebhookModule,
    StellarModule,
    AuditModule,
    AiModule,
    HealthModule,
    MetricsModule,
    DeadLetterModule,
    AdminModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: PublicRateLimitGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: ScopesGuard },
    { provide: APP_GUARD, useClass: AstroidThrottlerGuard },
    AgentPolicyGuard,
    { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
    { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AgentTraceInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditLogInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware, StructuredRequestLoggingMiddleware).forRoutes('*');
    consumer.apply(RequestMetricsMiddleware).forRoutes('*');
  }
}
