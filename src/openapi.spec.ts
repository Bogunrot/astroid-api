import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { PrismaService } from './database/prisma.service';
import { AppModule } from './app.module';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PathItemObject, OperationObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

// Set up environment variables before importing modules that depend on them
process.env.NODE_ENV = 'test';
process.env.APP_NAME = 'astroid-api';
process.env.PORT = '3000';
process.env.API_PREFIX = 'api/v1';
process.env.LOG_LEVEL = 'info';
process.env.CORS_ORIGINS = '*';

process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.DATABASE_CONNECTION_LIMIT = '10';
process.env.DATABASE_WORKER_CONNECTION_LIMIT = '3';
process.env.DATABASE_POOL_TIMEOUT_MS = '5000';
process.env.DATABASE_QUERY_TIMEOUT_MS = '5000';
process.env.DATABASE_STATEMENT_TIMEOUT_MS = '10000';
process.env.DATABASE_WORKER_QUERY_TIMEOUT_MS = '60000';

process.env.REDIS_HOST = 'localhost';
process.env.REDIS_PORT = '6379';
process.env.REDIS_PASSWORD = '';
process.env.REDIS_DB = '0';

process.env.JWT_ACCESS_SECRET = 'test-secret-key-32-chars-long!!';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-32-chars!!';
process.env.JWT_ACCESS_TTL = '900';
process.env.JWT_REFRESH_TTL = '1209600';
process.env.PASSKEY_RP_ID = 'localhost';
process.env.PASSKEY_RP_NAME = 'Astroid';
process.env.PASSKEY_ORIGIN = 'http://localhost:3001';

process.env.STELLAR_NETWORK = 'testnet';
process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
process.env.STELLAR_SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
process.env.STELLAR_REGISTRY_CONTRACT_ID = '';
process.env.STELLAR_USE_MOCK = 'true';

process.env.STORAGE_ENDPOINT = 'http://localhost:9000';
process.env.STORAGE_REGION = 'us-east-1';
process.env.STORAGE_BUCKET = 'astroid';
process.env.STORAGE_ACCESS_KEY = 'astroid';
process.env.STORAGE_SECRET_KEY = 'astroid-secret';

process.env.QUEUE_PREFIX = 'astroid';
process.env.QUEUE_CONCURRENCY = '5';

process.env.THROTTLE_AUTH_LIMIT = '10';
process.env.THROTTLE_API_LIMIT = '120';
process.env.THROTTLE_TTL = '60';

process.env.AI_PROVIDER = 'nvidia';
process.env.AI_PROVIDER_KEY = 'test-key';
process.env.AI_BASE_URL = 'https://integrate.api.nvidia.com/v1';
process.env.AI_MODEL = 'meta/llama-3.1-70b-instruct';

describe('OpenAPI Documentation', () => {
  let app: INestApplication;
  let moduleFixture: TestingModule;

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({
        enableShutdownHooks: vi.fn(),
        onModuleInit: vi.fn(),
        onModuleDestroy: vi.fn(),
        $connect: vi.fn(),
        $disconnect: vi.fn(),
        workerClient: {
          $connect: vi.fn(),
          $disconnect: vi.fn(),
        },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    
    // Apply global prefix like in main.ts
    const configService = app.get(ConfigService);
    const appConfig = configService.getOrThrow('app');
    app.setGlobalPrefix(appConfig.apiPrefix);
    
    await app.init();
  }, 60_000);

  afterAll(async () => {
    // The full AppModule opens Redis-backed queue observers (DLQ listeners,
    // throttler storage) that cannot connect in a test environment; a graceful
    // close can hang waiting on those sockets, so bound it with a timer.
    await Promise.race([
      (async () => {
        await app.close();
        await moduleFixture.close();
      })(),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }, 15_000);

  it('should generate a valid OpenAPI document', () => {
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

    expect(document).toBeDefined();
    expect(document.openapi).toMatch(/^3\.0\./);
    expect(document.info.title).toBe('Astroid API');
    expect(document.info.version).toBe('1.0');
    expect(document.paths).toBeDefined();
    expect(Object.keys(document.paths).length).toBeGreaterThan(0);
  });

  it('should have all paths with proper operations', () => {
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

    for (const [path, pathItem] of Object.entries(document.paths)) {
      expect(path).toMatch(/^\/api\/v1\//);
      
      const operations: (keyof PathItemObject)[] = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'];
      
      for (const method of operations) {
        const operation = pathItem[method] as OperationObject | undefined;
        if (operation) {
          expect(operation.summary || operation.description).toBeDefined();
          expect(operation.responses).toBeDefined();
          expect(Object.keys(operation.responses).length).toBeGreaterThan(0);
          
          // Verify at least one success response (2xx) is documented
          const hasSuccessResponse = Object.keys(operation.responses).some(
            (code) => code.startsWith('2')
          );
          expect(hasSuccessResponse).toBe(true);
        }
      }
    }
  });

  it('should have security schemes defined', () => {
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

    expect(document.components?.securitySchemes).toBeDefined();
    expect(document.components?.securitySchemes?.['access-token']).toBeDefined();
    expect(document.components?.securitySchemes?.['api-key']).toBeDefined();
  });

  it('should have tags for all endpoints', () => {
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

    for (const [, pathItem] of Object.entries(document.paths)) {
      const operations: (keyof PathItemObject)[] = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'];
      
      for (const method of operations) {
        const operation = pathItem[method] as OperationObject | undefined;
        if (operation) {
          expect(operation.tags).toBeDefined();
          expect(Array.isArray(operation.tags)).toBe(true);
          expect((operation.tags || []).length).toBeGreaterThan(0);
        }
      }
    }
  });
});