import { NestFactory } from '@nestjs/core';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { Logger as PinoLogger } from 'nestjs-pino';
import helmet from 'helmet';
import { Request, Response, NextFunction } from 'express';
import { AppModule } from './app.module';
import { PrismaService } from './database/prisma.service';
import { AppConfig } from './config/app.config';
import { assertValidEnvironment, EnvironmentValidationError } from './config/env.validation';
import { DatabaseConfig } from './config/database.config';

async function bootstrap() {
  // Fail fast on missing or malformed configuration, before any module is
  // constructed or any connection is opened. `.env` has already been merged
  // into `process.env` at this point: `ConfigModule.forRoot` loads it when
  // `AppModule` is imported.
  assertValidEnvironment(process.env);

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);
  const appConfig = config.getOrThrow<AppConfig>('app');
  const databaseConfig = config.getOrThrow<DatabaseConfig>('database');
  const prisma = app.get(PrismaService);

  // Startup migration check: refuse to accept traffic against a database
  // whose schema hasn't caught up with prisma/migrations (mode 'halt'), or
  // log a warning and continue (mode 'warn'). Reuses the same check
  // PrismaService.onModuleInit already ran (and logged) on connect.
  if (databaseConfig.migrationCheckEnabled) {
    const logger = app.get(PinoLogger);
    const result = await prisma.validateMigrations();

    if (!result.upToDate && databaseConfig.migrationCheckMode === 'halt') {
      logger.error(result.message, 'MigrationCheck');
      await app.close();
      throw new Error(`Migration check failed: ${result.message}`);
    }
  }

  // Structured logging (nestjs-pino)
  app.useLogger(app.get(PinoLogger));

  // Security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options,
  // Referrer-Policy). Swagger UI — served only outside production — needs inline
  // styles/scripts, so CSP is relaxed there and kept at helmet's strict default
  // in production.
  const isProduction = appConfig.nodeEnv === 'production';
  app.use(
    helmet({
      contentSecurityPolicy: isProduction
        ? undefined
        : {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'", "'unsafe-inline'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", 'data:', 'https:'],
            },
          },
      hsts: { maxAge: 15_552_000, includeSubDomains: true, preload: true },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  // Permissions-Policy is not part of helmet's defaults; disable powerful
  // browser features the API never uses.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), browsing-topics=()',
    );
    next();
  });

  // CORS
  app.enableCors({ origin: appConfig.corsOrigins, credentials: true });

  // Global validation pipe (transforms + validates DTOs)
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: false,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // API prefix (e.g. api/v1). Versioning is expressed via this stable prefix
  // rather than Nest URI versioning to avoid a duplicated version segment.
  // `/metrics` is excluded so it stays at a fixed, unversioned path for
  // Prometheus scrape configs. The liveness/readiness probes are excluded for
  // the same reason: orchestrator and load-balancer probe paths must not change
  // when the API version does.
  app.setGlobalPrefix(appConfig.apiPrefix, {
    exclude: [
      { path: 'metrics', method: RequestMethod.GET },
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
    ],
  });

  // OpenAPI / Swagger documentation
  if (appConfig.nodeEnv !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Astroid API')
      .setDescription(
        'The intelligence layer for the Financial Operating System for autonomous AI agents on Stellar.',
      )
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
      .addApiKey({ type: 'apiKey', in: 'header', name: 'x-api-key' }, 'api-key')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document);
  }

  // Prisma shutdown hook
  await prisma.enableShutdownHooks(app);

  await app.listen(appConfig.port);
  console.log(`🚀 Astroid API listening on port ${appConfig.port}`);
  console.log(`📚 Swagger docs: http://localhost:${appConfig.port}/docs`);
}

bootstrap().catch((error) => {
  if (error instanceof EnvironmentValidationError) {
    // The message already lists every failing variable; a stack trace would
    // only bury it.
    console.error(error.message);
  } else {
    console.error('Failed to bootstrap:', error);
  }
  process.exit(1);
});
