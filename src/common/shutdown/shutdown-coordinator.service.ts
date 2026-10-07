import {
  BeforeApplicationShutdown,
  INestApplication,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DiscoveryService } from '@nestjs/core';
import { WorkerHost } from '@nestjs/bullmq';
import { Queue, Worker } from 'bullmq';
import { Server, ServerResponse } from 'http';
import { ShutdownConfig } from '../../config/shutdown.config';

/**
 * Resource phases, closed in this order: the reverse of the order in which the
 * application depends on them. Queues publish through Redis-backed
 * connections and are drained first; the shared Redis client and finally the
 * database go last, once nothing can issue work against them.
 */
export const SHUTDOWN_RESOURCE_PHASES = ['queues', 'redis', 'database'] as const;

export type ShutdownPhase = (typeof SHUTDOWN_RESOURCE_PHASES)[number];

/** A connection or handle released by the coordinator during shutdown. */
export interface ShutdownResource {
  /** Stable, non-sensitive label used in logs. Never a URL or credential. */
  name: string;
  phase: ShutdownPhase;
  /** Releases the resource. Owned and implemented by the provider that created it. */
  close(): Promise<void>;
}

export type ShutdownSignal = 'SIGTERM' | 'SIGINT';

export interface ShutdownHookOptions {
  signals?: readonly ShutdownSignal[];
  /** Called with the exit code once shutdown completes. Defaults to `process.exit`. */
  exit?: (code: number) => void;
}

type Outcome = 'settled' | 'timeout';

/**
 * Coordinates graceful shutdown on SIGTERM / SIGINT so deployments do not
 * abandon in-flight API requests or BullMQ jobs.
 *
 * Nest's built-in `enableShutdownHooks()` runs `onModuleDestroy` hooks (which
 * disconnect Prisma) before it closes the HTTP server, has no grace period,
 * and exits by re-raising the signal. The coordinator instead runs a fixed
 * sequence, each step bounded so shutdown can never hang:
 *
 *   1. HTTP     stop accepting connections; let in-flight requests finish
 *   2. Workers  pause every BullMQ worker and let active jobs finish
 *               (steps 1-2 share the configurable grace period; anything
 *               still running when it expires is forcibly terminated)
 *   3. `app.close()`, which runs Nest's lifecycle hooks so every provider
 *      releases what it owns. From `beforeApplicationShutdown`, the
 *      coordinator closes registered resources phase by phase:
 *      queues -> redis -> database
 *
 * The process then exits 0 after a clean drain, or 1 if the grace period
 * expired or any step failed.
 *
 * Providers keep ownership of their connections: they register a `close`
 * callback via {@link register}, and the coordinator only decides when it
 * runs. Queues and workers created by `@nestjs/bullmq` are discovered
 * automatically at bootstrap.
 */
@Injectable()
export class ShutdownCoordinator implements OnApplicationBootstrap, BeforeApplicationShutdown {
  /** Upper bound for closing a single registered resource. */
  static readonly RESOURCE_CLOSE_TIMEOUT_MS = 3_000;
  /** Upper bound for `app.close()`, which includes every resource phase. */
  static readonly APP_CLOSE_TIMEOUT_MS = 15_000;
  static readonly DEFAULT_SIGNALS: readonly ShutdownSignal[] = ['SIGTERM', 'SIGINT'];

  private readonly logger = new Logger(ShutdownCoordinator.name);
  private readonly gracePeriodMs: number;
  private readonly resources: ShutdownResource[] = [];
  private readonly workers = new Set<Worker>();

  private app?: INestApplication;
  private shuttingDown = false;
  private shutdownPromise?: Promise<number>;
  private resourcesPromise?: Promise<string[]>;

  constructor(
    config: ConfigService,
    private readonly discovery: DiscoveryService,
  ) {
    this.gracePeriodMs = config.getOrThrow<ShutdownConfig>('shutdown').gracePeriodMs;
  }

  /** True once shutdown has begun. */
  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** Registers a resource to be closed in its phase during shutdown. */
  register(resource: ShutdownResource): void {
    if (this.resourcesPromise) {
      this.logger.warn(
        `Ignoring registration of "${resource.name}": resources are already closing`,
      );
      return;
    }
    this.resources.push(resource);
  }

  /** Discovers the BullMQ workers and queues created by `@nestjs/bullmq`. */
  onApplicationBootstrap(): void {
    for (const { instance } of this.discovery.getProviders()) {
      if (instance instanceof WorkerHost) {
        const worker = workerOf(instance);
        if (worker) {
          this.workers.add(worker);
        }
      } else if (instance instanceof Queue) {
        const queue = instance;
        this.register({ name: `queue:${queue.name}`, phase: 'queues', close: () => queue.close() });
      }
    }
  }

  /**
   * Installs SIGTERM / SIGINT handlers that run {@link shutdown} and exit with
   * its result. Called once from `main.ts` after the HTTP server is listening.
   * Repeated signals are logged and ignored while shutdown is in progress.
   */
  enableShutdownHooks(app: INestApplication, options: ShutdownHookOptions = {}): void {
    if (this.app) {
      return;
    }
    this.app = app;
    const exit = options.exit ?? ((code: number) => process.exit(code));

    // Ask keep-alive clients to disconnect after their current response, so
    // connections drain instead of carrying new requests. Prepended so it runs
    // before the application handler can send headers.
    const server = app.getHttpServer() as Server;
    server.prependListener('request', (_req, res: ServerResponse) => {
      if (this.shuttingDown && !res.headersSent) {
        res.setHeader('Connection', 'close');
      }
    });

    for (const signal of options.signals ?? ShutdownCoordinator.DEFAULT_SIGNALS) {
      process.on(signal, () => {
        if (this.shutdownPromise) {
          this.logger.warn(`Received ${signal} while shutdown is already in progress; ignoring`);
          return;
        }
        void this.shutdown(signal).then(exit);
      });
    }
  }

  /**
   * Runs the shutdown sequence once and resolves with the process exit code:
   * 0 after a clean drain, 1 if the grace period expired or a step failed.
   * Concurrent and repeated calls share the same run.
   */
  shutdown(reason = 'shutdown request'): Promise<number> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = this.run(reason);
    }
    return this.shutdownPromise;
  }

  /**
   * Closes registered resources phase by phase. Runs inside `app.close()`
   * after every `onModuleDestroy` hook, so it also releases connections when
   * a module is closed outside a signal (for example in tests). Idempotent.
   */
  async beforeApplicationShutdown(): Promise<void> {
    await this.closeResources();
  }

  private async run(reason: string): Promise<number> {
    this.shuttingDown = true;
    const startedAt = Date.now();
    const deadline = startedAt + this.gracePeriodMs;
    this.logger.log(`Received ${reason}; shutting down (grace period ${this.gracePeriodMs}ms)`);

    const failures: string[] = [];
    try {
      failures.push(...(await this.drainHttp(deadline)));
      failures.push(...(await this.drainWorkers(deadline)));
      failures.push(...(await this.closeApplication()));
    } catch (error) {
      failures.push(`unexpected error: ${describe(error)}`);
    }

    const elapsedMs = Date.now() - startedAt;
    if (failures.length > 0) {
      this.logger.error(
        `Shutdown finished with ${failures.length} problem(s) after ${elapsedMs}ms: ${failures.join('; ')}`,
      );
      return 1;
    }
    this.logger.log(`Shutdown complete in ${elapsedMs}ms`);
    return 0;
  }

  /** Stops accepting connections and waits for in-flight requests. */
  private async drainHttp(deadline: number): Promise<string[]> {
    const server = this.app?.getHttpServer() as Server | undefined;
    if (!server?.listening) {
      return [];
    }

    const startedAt = Date.now();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections();

    if ((await settleBy(closed, deadline)) === 'timeout') {
      server.closeAllConnections();
      this.logger.error(
        `HTTP: in-flight requests did not finish within the ${this.gracePeriodMs}ms grace period; ` +
          'closed remaining connections',
      );
      return ['http: grace period expired with requests in flight'];
    }
    this.logger.log(
      `HTTP: stopped accepting connections and drained in-flight requests (${Date.now() - startedAt}ms)`,
    );
    return [];
  }

  /**
   * Pauses every worker (no new jobs are fetched) and waits for active jobs,
   * then closes it. Workers still busy at the deadline are force-closed; their
   * jobs' locks lapse and BullMQ's stalled-job recovery re-queues them.
   */
  private async drainWorkers(deadline: number): Promise<string[]> {
    const results = await Promise.all(
      Array.from(this.workers, async (worker): Promise<string | null> => {
        const startedAt = Date.now();
        try {
          if ((await settleBy(worker.pause(), deadline)) === 'timeout') {
            this.logger.error(
              `Worker "${worker.name}": active jobs did not finish within the ${this.gracePeriodMs}ms ` +
                'grace period; forcing close. Interrupted jobs will be retried after their lock expires',
            );
            await settleWithin(worker.close(true), ShutdownCoordinator.RESOURCE_CLOSE_TIMEOUT_MS);
            return `worker "${worker.name}": grace period expired with jobs in progress`;
          }
          if (
            (await settleWithin(worker.close(), ShutdownCoordinator.RESOURCE_CLOSE_TIMEOUT_MS)) ===
            'timeout'
          ) {
            return `worker "${worker.name}": close timed out`;
          }
          this.logger.log(
            `Worker "${worker.name}": drained and closed (${Date.now() - startedAt}ms)`,
          );
          return null;
        } catch (error) {
          this.logger.error(`Worker "${worker.name}": failed to close: ${describe(error)}`);
          return `worker "${worker.name}": ${describe(error)}`;
        }
      }),
    );
    return results.filter((failure): failure is string => failure !== null);
  }

  /** Runs Nest's lifecycle hooks (which close registered resources). */
  private async closeApplication(): Promise<string[]> {
    const failures: string[] = [];
    if (this.app) {
      const app = this.app;
      try {
        if (
          (await settleWithin(app.close(), ShutdownCoordinator.APP_CLOSE_TIMEOUT_MS)) === 'timeout'
        ) {
          this.logger.error(
            `Application lifecycle hooks did not finish within ${ShutdownCoordinator.APP_CLOSE_TIMEOUT_MS}ms`,
          );
          failures.push('application: lifecycle hooks timed out');
        }
      } catch (error) {
        this.logger.error(`Application lifecycle hooks failed: ${describe(error)}`);
        failures.push(`application: ${describe(error)}`);
      }
    }
    // Resource failures are collected from the (idempotent) phase run, whether
    // it happened inside app.close() or has to happen now.
    failures.push(...(await this.closeResources()));
    return failures;
  }

  private closeResources(): Promise<string[]> {
    if (!this.resourcesPromise) {
      this.resourcesPromise = this.closeResourcePhases();
    }
    return this.resourcesPromise;
  }

  private async closeResourcePhases(): Promise<string[]> {
    const failures: string[] = [];
    for (const phase of SHUTDOWN_RESOURCE_PHASES) {
      const members = this.resources.filter((resource) => resource.phase === phase);
      const results = await Promise.all(members.map((resource) => this.closeResource(resource)));
      failures.push(...results.filter((failure): failure is string => failure !== null));
    }
    return failures;
  }

  private async closeResource(resource: ShutdownResource): Promise<string | null> {
    const startedAt = Date.now();
    try {
      const outcome = await settleWithin(
        Promise.resolve().then(() => resource.close()),
        ShutdownCoordinator.RESOURCE_CLOSE_TIMEOUT_MS,
      );
      if (outcome === 'timeout') {
        this.logger.error(
          `Closing ${resource.phase} resource "${resource.name}" timed out after ${ShutdownCoordinator.RESOURCE_CLOSE_TIMEOUT_MS}ms`,
        );
        return `${resource.phase} "${resource.name}": close timed out`;
      }
      this.logger.log(
        `Closed ${resource.phase} resource "${resource.name}" (${Date.now() - startedAt}ms)`,
      );
      return null;
    } catch (error) {
      this.logger.error(
        `Closing ${resource.phase} resource "${resource.name}" failed: ${describe(error)}`,
      );
      return `${resource.phase} "${resource.name}": ${describe(error)}`;
    }
  }
}

/** The BullMQ worker behind a `@Processor` host, if it has been created. */
function workerOf(host: WorkerHost): Worker | undefined {
  try {
    return host.worker;
  } catch {
    // The getter throws until @nestjs/bullmq has registered the worker.
    return undefined;
  }
}

/** Resolves when `work` settles or at `deadline` (epoch ms), whichever is first. Rejections propagate. */
function settleBy(work: Promise<unknown>, deadline: number): Promise<Outcome> {
  return settleWithin(work, Math.max(0, deadline - Date.now()));
}

function settleWithin(work: Promise<unknown>, timeoutMs: number): Promise<Outcome> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Outcome>((resolve) => {
    // Deliberately not unref'd: the pending deadline must keep the process
    // alive until the step is resolved one way or the other.
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  return Promise.race([work.then((): Outcome => 'settled'), timeout]).finally(() =>
    clearTimeout(timer),
  );
}

/** Error summary for logs: class and message only, never payloads. */
function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
