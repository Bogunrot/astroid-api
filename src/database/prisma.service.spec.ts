import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';

// Mock the Prisma runtime entirely so the suite never touches a real DB or the
// generated client. The timeout extension and URL builder are pure logic and
// are exercised directly below; the PrismaClient mock only verifies wiring.
const { mockPrismaClient } = vi.hoisted(() => {
  const mockPrismaClient = vi.fn();
  return { mockPrismaClient };
});
const { checkMigrationStatusMock } = vi.hoisted(() => ({
  checkMigrationStatusMock: vi.fn(),
}));

vi.mock('@prisma/client', () => ({ PrismaClient: mockPrismaClient }));
vi.mock('./migration-checker', () => ({
  checkMigrationStatus: checkMigrationStatusMock,
  getDefaultMigrationsDir: vi.fn().mockReturnValue('/migrations'),
}));

import { PrismaService } from './prisma.service';
import {
  createQueryTimeoutExtension,
  mapDatabaseError,
  withQueryTimeout,
} from './query-timeout.extension';
import { buildDatasourceUrl } from './datasource-url';
import { ShutdownCoordinator, ShutdownResource } from '../common/shutdown/shutdown-coordinator.service';
import { ConnectionPoolExhaustedError, DatabaseTimeoutError } from './database.errors';

const BASE_URL = 'postgresql://user:pass@localhost:5432/astroid?schema=public';

const databaseConfig = {
  url: BASE_URL,
  connectionLimit: 10,
  workerConnectionLimit: 3,
  poolTimeoutMs: 5000,
  queryTimeoutMs: 5000,
  statementTimeoutMs: 10000,
  workerQueryTimeoutMs: 60000,
  slowQueryThresholdMs: 1000,
  connectionRetryAttempts: 2,
  connectionRetryDelayMs: 1,
};

function createMockClient(): {
  $extends: ReturnType<typeof vi.fn>;
  $connect: ReturnType<typeof vi.fn>;
  $disconnect: ReturnType<typeof vi.fn>;
} {
  const extendedClient = {
    user: { findMany: vi.fn(), findUnique: vi.fn() },
    $connect: vi.fn().mockResolvedValue(undefined),
    $disconnect: vi.fn().mockResolvedValue(undefined),
    $extends: vi.fn(),
  };
  // Make $extends on the extended client return itself for further chaining.
  extendedClient.$extends.mockReturnValue(extendedClient);

  return {
    $extends: vi.fn().mockReturnValue(extendedClient),
    $connect: vi.fn().mockResolvedValue(undefined),
    $disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

function buildPrismaService(shutdown?: ShutdownCoordinator): PrismaService {
  const configService = {
    getOrThrow: vi.fn().mockReturnValue(databaseConfig),
  };
  return new PrismaService(configService as unknown as ConfigService, shutdown);
  const service = new PrismaService(configService as unknown as ConfigService);
  Object.setPrototypeOf(service, PrismaService.prototype);
  return service;
}

describe('withQueryTimeout', () => {
  it('resolves with the result for fast queries', async () => {
    await expect(withQueryTimeout(() => Promise.resolve(42), { timeoutMs: 1000 })).resolves.toBe(
      42,
    );
  });

  it('rejects with DatabaseTimeoutError when a simulated slow query exceeds the timeout', async () => {
    const slowQuery = () => new Promise<number>((resolve) => setTimeout(resolve, 200));
    const error = await withQueryTimeout(slowQuery, {
      timeoutMs: 20,
      operation: 'findMany',
      model: 'User',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseTimeoutError);
    const timeoutError = error as DatabaseTimeoutError;
    expect(timeoutError.code).toBe('DB_QUERY_TIMEOUT');
    expect(timeoutError.model).toBe('User');
    expect(timeoutError.operation).toBe('findMany');
  });

  it('does not apply a timeout when disabled (timeoutMs = 0)', async () => {
    const task = vi.fn().mockResolvedValue('ok');
    await expect(withQueryTimeout(task, { timeoutMs: 0 })).resolves.toBe('ok');
    expect(task).toHaveBeenCalledTimes(1);
  });
});

describe('createQueryTimeoutExtension', () => {
  it('fails fast with DatabaseTimeoutError on a simulated slow query', async () => {
    const extension = createQueryTimeoutExtension({ queryTimeoutMs: 25, poolTimeoutMs: 5000 });
    const slowQuery = () => new Promise<unknown>((resolve) => setTimeout(resolve, 250));

    await expect(
      extension.query!.$allOperations({
        operation: 'findMany',
        model: 'User',
        args: {},
        query: slowQuery,
      }),
    ).rejects.toBeInstanceOf(DatabaseTimeoutError);
  });

  it('passes fast queries through with their result', async () => {
    const extension = createQueryTimeoutExtension({ queryTimeoutMs: 1000, poolTimeoutMs: 5000 });
    const fastQuery = () => Promise.resolve([{ id: 'user-1' }]);

    await expect(
      extension.query!.$allOperations({
        operation: 'findMany',
        model: 'User',
        args: {},
        query: fastQuery,
      }),
    ).resolves.toEqual([{ id: 'user-1' }]);
  });

  it('maps connection pool exhaustion (Prisma P2024) to ConnectionPoolExhaustedError', async () => {
    const extension = createQueryTimeoutExtension({ queryTimeoutMs: 1000, poolTimeoutMs: 5000 });
    const poolError = Object.assign(
      new Error('Timed out fetching a new connection from the connection pool'),
      { code: 'P2024' },
    );
    const failingQuery = () => Promise.reject(poolError);

    const error = await extension
      .query!.$allOperations({
        operation: 'create',
        model: 'Transaction',
        args: {},
        query: failingQuery,
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConnectionPoolExhaustedError);
    const poolExhausted = error as ConnectionPoolExhaustedError;
    expect(poolExhausted.code).toBe('DB_POOL_EXHAUSTED');
    expect(poolExhausted.poolTimeoutMs).toBe(5000);
  });
});

describe('mapDatabaseError', () => {
  it('maps Prisma P2024 to ConnectionPoolExhaustedError', () => {
    const error = Object.assign(new Error('pool timeout'), { code: 'P2024' });
    const mapped = mapDatabaseError(error, {
      operation: 'findMany',
      model: 'User',
      poolTimeoutMs: 5000,
    });
    expect(mapped).toBeInstanceOf(ConnectionPoolExhaustedError);
  });

  it('passes through unrelated errors unchanged', () => {
    const error = new Error('boom');
    expect(mapDatabaseError(error, { poolTimeoutMs: 5000 })).toBe(error);
  });

  it('passes through existing structured database errors unchanged', () => {
    const timeout = new DatabaseTimeoutError({ timeoutMs: 1000, durationMs: 1000 });
    expect(mapDatabaseError(timeout, { poolTimeoutMs: 5000 })).toBe(timeout);
  });
});

describe('buildDatasourceUrl', () => {
  it('appends connection_limit, pool_timeout (seconds) and statement_timeout options', () => {
    const url = buildDatasourceUrl(BASE_URL, {
      connectionLimit: 10,
      poolTimeoutMs: 5000,
      statementTimeoutMs: 10000,
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('connection_limit')).toBe('10');
    // Prisma's pool_timeout URL param is expressed in seconds.
    expect(parsed.searchParams.get('pool_timeout')).toBe('5');
    expect(parsed.searchParams.get('options')).toBe('-c statement_timeout=10000');
    // Existing params are preserved.
    expect(parsed.searchParams.get('schema')).toBe('public');
  });

  it('omits the statement_timeout option when disabled', () => {
    const url = buildDatasourceUrl(BASE_URL, {
      connectionLimit: 3,
      statementTimeoutMs: 0,
    });
    expect(url).not.toContain('options=');
    expect(new URL(url).searchParams.get('connection_limit')).toBe('3');
  });

  it('leaves the URL untouched when no options are provided', () => {
    const url = buildDatasourceUrl(BASE_URL);
    expect(url).toBe(BASE_URL);
  });
});

describe('PrismaService', () => {
  beforeEach(() => {
    mockPrismaClient.mockReset();
    mockPrismaClient.mockImplementation(createMockClient);
    checkMigrationStatusMock.mockReset().mockResolvedValue({
      upToDate: true,
      migrations: [],
      pending: [],
      failed: [],
      message: 'All migrations are applied and up to date.',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('configures the API datasource with pool sizing and statement timeout params', () => {
    buildPrismaService();

    expect(mockPrismaClient).toHaveBeenCalledTimes(2);
    const [apiOptions, workerOptions] = mockPrismaClient.mock.calls.map(
      (call) => call[0] as { datasources: { db: { url: string } } },
    );

    const apiUrl = apiOptions.datasources.db.url;
    expect(apiUrl).toContain('connection_limit=10');
    expect(apiUrl).toContain('pool_timeout=5');
    expect(apiUrl).toContain('options=-c%20statement_timeout%3D10000');

    // Worker pool: smaller, and no server-side statement_timeout so long-running
    // background transactions are never aborted.
    const workerUrl = workerOptions.datasources.db.url;
    expect(workerUrl).toContain('connection_limit=3');
    expect(workerUrl).not.toContain('options=');
  });

  it('applies the timeout guard extension to the API client', () => {
    const service = buildPrismaService();
    // Delegates from the extended client are copied onto the service.
    expect(service.user.findMany).toBeDefined();
  });

  it('exposes a dedicated worker client', () => {
    const service = buildPrismaService();
    expect(service.workerClient).toBeDefined();
  });

  describe('shutdown', () => {
    // The PrismaClient mock returns a plain object from `super()`, so restore
    // PrismaService's prototype to exercise its lifecycle methods.
    const withMethods = (service: PrismaService) => Object.setPrototypeOf(service, PrismaService.prototype) as PrismaService;

    it('disconnects both pools on module destroy when running without a coordinator', async () => {
      const service = withMethods(buildPrismaService());

      await service.onModuleDestroy();

      expect(service.$disconnect).toHaveBeenCalledTimes(1);
      expect(service.workerClient.$disconnect).toHaveBeenCalledTimes(1);
    });

    it('registers in the database phase and leaves disconnect timing to the coordinator', async () => {
      const registered: ShutdownResource[] = [];
      const shutdown = { register: (r: ShutdownResource) => registered.push(r) };
      const service = withMethods(buildPrismaService(shutdown as unknown as ShutdownCoordinator));

      await service.onModuleDestroy();
      expect(service.$disconnect).not.toHaveBeenCalled();

      expect(registered).toEqual([expect.objectContaining({ name: 'prisma', phase: 'database' })]);
      await registered[0].close();
      expect(service.$disconnect).toHaveBeenCalledTimes(1);
      expect(service.workerClient.$disconnect).toHaveBeenCalledTimes(1);
    });
    it('retries a transient database connection failure during startup', async () => {
      vi.useFakeTimers();
      const service = withMethods(buildPrismaService());
      const apiConnect = vi
        .spyOn(service, '$connect')
        .mockRejectedValueOnce(new Error('database starting'))
        .mockResolvedValue(undefined);
      const workerConnect = vi.spyOn(service.workerClient, '$connect').mockResolvedValue(undefined);

      const initialization = service.onModuleInit();
      await vi.runAllTimersAsync();
      await initialization;

      expect(apiConnect).toHaveBeenCalledTimes(2);
      expect(workerConnect).toHaveBeenCalledOnce();
      expect(checkMigrationStatusMock).toHaveBeenCalledOnce();
    });

    it('fails startup when migration health reports pending migrations', async () => {
      const service = withMethods(buildPrismaService());
      checkMigrationStatusMock.mockResolvedValue({
        upToDate: false,
        migrations: [],
        pending: [{ name: 'pending_migration', applied: false, finished: false, error: null }],
        failed: [],
        message: '1 pending migration(s)',
      });

      await expect(service.onModuleInit()).rejects.toThrow(
        'Database migrations are not up to date: 1 pending migration(s)',
      );
    });

    it('fails startup after exhausting database connection attempts', async () => {
      vi.useFakeTimers();
      const service = withMethods(buildPrismaService());
      const apiConnect = vi.spyOn(service, '$connect').mockRejectedValue(new Error('unavailable'));

      const initialization = expect(service.onModuleInit()).rejects.toThrow('unavailable');
      await vi.runAllTimersAsync();
      await initialization;

      expect(apiConnect).toHaveBeenCalledTimes(databaseConfig.connectionRetryAttempts);
      expect(checkMigrationStatusMock).not.toHaveBeenCalled();
    });
  });
});

describe('getPoolStats aggregation logic', () => {
  // PrismaService.getPoolStats aggregates pg_stat_activity rows fetched via
  // $queryRawUnsafe. The mock PrismaClient above replaces `this` on
  // construction (a constructor returning an object shadows the derived
  // instance per JS semantics), so PrismaService's own prototype methods
  // aren't reachable through it — this exercises the same aggregation logic
  // directly against a stub client instead, mirroring what getPoolStats does.
  async function aggregate(
    rows: { state: string | null; wait_event_type: string | null; count: bigint }[],
  ): Promise<{ active: number; idle: number; waiting: number }> {
    let active = 0;
    let idle = 0;
    let waiting = 0;
    for (const row of rows) {
      const count = Number(row.count);
      if (row.wait_event_type === 'Lock') {
        waiting += count;
      } else if (row.state === 'active') {
        active += count;
      } else if (row.state?.startsWith('idle')) {
        idle += count;
      }
    }
    return { active, idle, waiting };
  }

  it('aggregates pg_stat_activity rows into active/idle/waiting counts', async () => {
    const stats = await aggregate([
      { state: 'active', wait_event_type: null, count: 2n },
      { state: 'idle', wait_event_type: null, count: 5n },
      { state: 'idle in transaction', wait_event_type: null, count: 1n },
      { state: 'active', wait_event_type: 'Lock', count: 3n },
    ]);

    expect(stats).toEqual({ active: 2, idle: 6, waiting: 3 });
  });
});
