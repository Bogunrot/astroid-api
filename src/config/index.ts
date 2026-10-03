import { ConfigModule } from '@nestjs/config';
import { appConfig } from './app.config';
import { databaseConfig } from './database.config';
import { redisConfig } from './redis.config';
import { authConfig } from './auth.config';
import { stellarConfig } from './stellar.config';
import { storageConfig } from './storage.config';
import { queueConfig } from './queue.config';
import { aiConfig } from './ai.config';
import { metricsConfig } from './metrics.config';
import { encryptionConfig } from './encryption.config';
import { rateLimitConfig } from './rate-limit.config';
import { throttlerConfig } from './throttler.config';

export * from './app.config';
export * from './database.config';
export * from './redis.config';
export * from './auth.config';
export * from './stellar.config';
export * from './storage.config';
export * from './queue.config';
export * from './ai.config';
export * from './metrics.config';
export * from './encryption.config';
export * from './rate-limit.config';
export * from './throttler.config';

/**
 * Global configuration module. Every slice is registered via `registerAs` and
 * validates its own environment variables eagerly on startup.
 */
export const AppConfigModule = ConfigModule.forRoot({
  isGlobal: true,
  cache: true,
  expandVariables: true,
  load: [
    appConfig,
    databaseConfig,
    redisConfig,
    authConfig,
    stellarConfig,
    storageConfig,
    queueConfig,
    aiConfig,
    metricsConfig,
    encryptionConfig,
    rateLimitConfig,
    throttlerConfig,
  ],
});
