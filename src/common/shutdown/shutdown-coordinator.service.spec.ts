import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DiscoveryService } from '@nestjs/core';
import { WorkerHost } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ShutdownCoordinator, ShutdownPhase } from './shutdown-coordinator.service';

/** Resolves on demand, to model work that is still in flight. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Lets pending promise callbacks run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

class TestProcessor extends WorkerHost {
  async process(): Promise<void> {
    return undefined;
  }
}

describe('ShutdownCoordinator', () => {
  const GRACE_MS = 1_000;
  let events: string[];
  let coordinator: ShutdownCoordinator;
  let providers: Array<{ instance: unknown }>;

  let httpDone: ReturnType<typeof deferred>;
  let server: {
    listening: boolean;
    close: ReturnType<typeof vi.fn>;
    closeIdleConnections: ReturnType<typeof vi.fn>;
    closeAllConnections: ReturnType<typeof vi.fn>;
    prependListener: ReturnType<typeof vi.fn>;
  };
  let app: { getHttpServer: () => typeof server; close: ReturnType<typeof vi.fn> };
  let worker: {
    name: string;
    pause: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  let queueClose: ReturnType<typeof vi.fn>;
  let errorLog: ReturnType<typeof vi.spyOn>;

  const resource = (name: string, phase: ShutdownPhase, close?: () => Promise<void>) =>
    coordinator.register({
      name,
      phase,
      close:
        close ??
        (async () => {
          events.push(`${phase}:${name}`);
        }),
    });

  beforeEach(() => {
    events = [];
    errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    httpDone = deferred();
    httpDone.resolve();
    server = {
      listening: true,
      close: vi.fn((callback: () => void) => {
        events.push('http:stop-accepting');
        void httpDone.promise.then(() => {
          events.push('http:drained');
          callback();
        });
      }),
      closeIdleConnections: vi.fn(),
      closeAllConnections: vi.fn(() => events.push('http:force-closed')),
      prependListener: vi.fn(),
    };

    worker = {
      name: 'webhooks',
      pause: vi.fn(async () => {
        events.push('worker:paused');
      }),
      close: vi.fn(async (force?: boolean) => {
        events.push(force ? 'worker:force-closed' : 'worker:closed');
      }),
    };
    const host = new TestProcessor();
    Object.defineProperty(host, 'worker', { value: worker });

    const queue = Object.create(Queue.prototype) as Queue;
    queueClose = vi.fn(async () => {
      events.push('queues:queue:webhooks');
    });
    Object.defineProperty(queue, 'name', { value: 'webhooks' });
    Object.defineProperty(queue, 'close', { value: queueClose });

    providers = [
      { instance: host },
      { instance: queue },
      { instance: undefined },
      { instance: {} },
    ];

    const config = {
      getOrThrow: vi.fn().mockReturnValue({ gracePeriodMs: GRACE_MS }),
    } as unknown as ConfigService;
    const discovery = { getProviders: () => providers } as unknown as DiscoveryService;
    coordinator = new ShutdownCoordinator(config, discovery);

    // Mirrors Nest's app.close(): lifecycle hooks, then beforeApplicationShutdown.
    app = {
      getHttpServer: () => server,
      close: vi.fn(async () => {
        events.push('app:lifecycle-hooks');
        await coordinator.beforeApplicationShutdown();
      }),
    };

    // Registered out of order on purpose: phases, not registration order,
    // decide the close order.
    resource('prisma', 'database');
    resource('redis:shared', 'redis');
    coordinator.onApplicationBootstrap();

    coordinator.enableShutdownHooks(app as unknown as INestApplication, {
      signals: [],
      exit: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('drains and closes everything in order, then reports a clean exit', async () => {
    await expect(coordinator.shutdown('SIGTERM')).resolves.toBe(0);

    expect(events).toEqual([
      'http:stop-accepting',
      'http:drained',
      'worker:paused',
      'worker:closed',
      'app:lifecycle-hooks',
      'queues:queue:webhooks',
      'redis:redis:shared',
      'database:prisma',
    ]);
    expect(server.closeIdleConnections).toHaveBeenCalled();
    expect(server.closeAllConnections).not.toHaveBeenCalled();
    expect(worker.close).toHaveBeenCalledWith();
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('waits for in-flight requests and jobs before releasing queues, Redis and Prisma', async () => {
    httpDone = deferred();
    const job = deferred();
    worker.pause.mockImplementation(async () => {
      await job.promise;
      events.push('worker:paused');
    });

    const result = coordinator.shutdown('SIGTERM');
    await flush();
    expect(events).toEqual(['http:stop-accepting']);
    expect(coordinator.isShuttingDown).toBe(true);

    httpDone.resolve();
    await flush();
    expect(events).toEqual(['http:stop-accepting', 'http:drained']);
    expect(worker.pause).toHaveBeenCalled();

    job.resolve();
    await expect(result).resolves.toBe(0);
    expect(events.slice(2)).toEqual([
      'worker:paused',
      'worker:closed',
      'app:lifecycle-hooks',
      'queues:queue:webhooks',
      'redis:redis:shared',
      'database:prisma',
    ]);
  });

  it('force-closes workers whose jobs outlive the grace period and exits non-zero', async () => {
    vi.useFakeTimers();
    worker.pause.mockReturnValue(new Promise(() => undefined));

    const result = coordinator.shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(GRACE_MS);

    await expect(result).resolves.toBe(1);
    expect(worker.close).toHaveBeenCalledWith(true);
    expect(events).toEqual([
      'http:stop-accepting',
      'http:drained',
      'worker:force-closed',
      'app:lifecycle-hooks',
      'queues:queue:webhooks',
      'redis:redis:shared',
      'database:prisma',
    ]);
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining(
        'Worker "webhooks": active jobs did not finish within the 1000ms grace period',
      ),
    );
  });

  it('closes lingering HTTP connections when requests outlive the grace period', async () => {
    vi.useFakeTimers();
    httpDone = deferred();

    const result = coordinator.shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(GRACE_MS);

    await expect(result).resolves.toBe(1);
    expect(server.closeAllConnections).toHaveBeenCalled();
    expect(events.slice(0, 2)).toEqual(['http:stop-accepting', 'http:force-closed']);
    expect(events).toContain('database:prisma');
  });

  it('shares one grace period between HTTP and worker draining', async () => {
    vi.useFakeTimers();
    httpDone = deferred();
    setTimeout(() => httpDone.resolve(), 800);
    worker.pause.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 500)));

    const result = coordinator.shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(GRACE_MS);

    // 800ms of HTTP drain leaves 200ms, less than the 500ms the job needs.
    await expect(result).resolves.toBe(1);
    expect(worker.close).toHaveBeenCalledWith(true);
  });

  it('keeps closing later phases when a resource fails, then exits non-zero', async () => {
    const failing = new Error('connection reset');
    Object.assign(failing, { payload: { secret: 'job-data-must-not-be-logged' } });
    resource('redis:auth', 'redis', async () => {
      throw failing;
    });

    await expect(coordinator.shutdown('SIGTERM')).resolves.toBe(1);

    expect(events).toContain('database:prisma');
    const logged = errorLog.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('Closing redis resource "redis:auth" failed: Error: connection reset');
    expect(logged).not.toContain('job-data-must-not-be-logged');
  });

  it('bounds a resource close that never settles', async () => {
    vi.useFakeTimers();
    resource('redis:auth', 'redis', () => new Promise(() => undefined));

    const result = coordinator.shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(ShutdownCoordinator.RESOURCE_CLOSE_TIMEOUT_MS);

    await expect(result).resolves.toBe(1);
    expect(events).toContain('database:prisma');
  });

  it('exits non-zero when a worker fails to close', async () => {
    worker.close.mockRejectedValue(new Error('redis gone'));

    await expect(coordinator.shutdown('SIGTERM')).resolves.toBe(1);
    expect(events).toContain('database:prisma');
  });

  it('still closes resources when the application lifecycle hooks hang', async () => {
    vi.useFakeTimers();
    app.close.mockReturnValue(new Promise(() => undefined));

    const result = coordinator.shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(ShutdownCoordinator.APP_CLOSE_TIMEOUT_MS);

    await expect(result).resolves.toBe(1);
    expect(events.slice(-3)).toEqual([
      'queues:queue:webhooks',
      'redis:redis:shared',
      'database:prisma',
    ]);
  });

  it('runs cleanup once when shutdown is requested repeatedly', async () => {
    const first = coordinator.shutdown('SIGTERM');
    const second = coordinator.shutdown('SIGINT');

    expect(second).toBe(first);
    await expect(first).resolves.toBe(0);
    await expect(coordinator.shutdown('SIGTERM')).resolves.toBe(0);

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(worker.pause).toHaveBeenCalledTimes(1);
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(queueClose).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event === 'database:prisma')).toHaveLength(1);
  });

  it('closes resources in phase order when the app is closed without a signal', async () => {
    await coordinator.beforeApplicationShutdown();
    await coordinator.beforeApplicationShutdown();

    expect(events).toEqual(['queues:queue:webhooks', 'redis:redis:shared', 'database:prisma']);
  });

  it('ignores registrations that arrive after resources started closing', async () => {
    await coordinator.beforeApplicationShutdown();
    const late = vi.fn(async () => undefined);

    coordinator.register({ name: 'late', phase: 'redis', close: late });
    await coordinator.beforeApplicationShutdown();

    expect(late).not.toHaveBeenCalled();
  });

  it('skips HTTP draining when the server is not listening', async () => {
    server.listening = false;

    await expect(coordinator.shutdown('SIGTERM')).resolves.toBe(0);
    expect(server.close).not.toHaveBeenCalled();
  });

  describe('signal handling', () => {
    let handlers: Map<string, () => void>;
    let exit: ReturnType<typeof vi.fn>;
    let fresh: ShutdownCoordinator;

    beforeEach(() => {
      handlers = new Map();
      vi.spyOn(process, 'on').mockImplementation(((signal: string, handler: () => void) => {
        handlers.set(signal, handler);
        return process;
      }) as typeof process.on);
      exit = vi.fn();

      fresh = new ShutdownCoordinator(
        { getOrThrow: () => ({ gracePeriodMs: GRACE_MS }) } as unknown as ConfigService,
        { getProviders: () => [] } as unknown as DiscoveryService,
      );
      server.listening = false;
      fresh.enableShutdownHooks(
        {
          getHttpServer: () => server,
          close: vi.fn(async () => undefined),
        } as unknown as INestApplication,
        { exit },
      );
    });

    it('listens for SIGTERM and SIGINT', () => {
      expect([...handlers.keys()]).toEqual(['SIGTERM', 'SIGINT']);
    });

    it('exits with the shutdown result, once, however many signals arrive', async () => {
      handlers.get('SIGTERM')?.();
      handlers.get('SIGINT')?.();
      handlers.get('SIGTERM')?.();
      await vi.waitFor(() => expect(exit).toHaveBeenCalled());
      await flush();

      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
    });

    it('does not install handlers twice', () => {
      const before = handlers.size;
      vi.mocked(process.on).mockClear();

      fresh.enableShutdownHooks({ getHttpServer: () => server } as unknown as INestApplication, {
        exit,
      });

      expect(process.on).not.toHaveBeenCalled();
      expect(handlers.size).toBe(before);
    });

    it('asks keep-alive clients to disconnect once shutdown begins', async () => {
      const onRequest = server.prependListener.mock.calls.at(-1)?.[1] as (
        req: unknown,
        res: { headersSent: boolean; setHeader: ReturnType<typeof vi.fn> },
      ) => void;
      const res = { headersSent: false, setHeader: vi.fn() };

      onRequest({}, res);
      expect(res.setHeader).not.toHaveBeenCalled();

      void fresh.shutdown('SIGTERM');
      onRequest({}, res);
      expect(res.setHeader).toHaveBeenCalledWith('Connection', 'close');
    });
  });
});
