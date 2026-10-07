# Graceful Shutdown

On `SIGTERM` or `SIGINT`, the API drains in-flight work before exiting, so a
deployment never abandons an HTTP request or a BullMQ job halfway through a
financial operation.

The sequence is run by `ShutdownCoordinator` (`src/common/shutdown`), installed
from `src/main.ts`:

| Step | What happens | Bound |
| --- | --- | --- |
| 1. HTTP | The server stops accepting connections. Idle keep-alive connections are closed and in-flight responses carry `Connection: close`. | Grace period |
| 2. Workers | Every BullMQ worker is paused (no new jobs are fetched) and its active jobs finish, then the worker is closed. | Grace period (shared with step 1) |
| 3. Lifecycle hooks | `app.close()` runs Nest's `onModuleDestroy` / `beforeApplicationShutdown` / `onApplicationShutdown` hooks, so every provider releases what it owns. | 15s |
| 4. Queues | BullMQ queues are closed. | 3s per resource |
| 5. Redis | Shared Redis clients are closed with `QUIT`. | 3s per resource |
| 6. Database | Both Prisma connection pools are disconnected. | 3s per resource |

Steps 4-6 run inside step 3 (from `beforeApplicationShutdown`), so they also
run when a module is closed outside a signal, for example in tests.

## Exit codes

- `0`: everything drained and closed.
- `1`: the grace period expired with requests or jobs still in progress, or a
  resource failed to close. The logs name the step and resource that failed.
  They include resource names and timings only, never job payloads or
  connection strings.

When the grace period expires, remaining HTTP connections are destroyed and
busy workers are force-closed. The interrupted jobs' locks lapse, and BullMQ's
stalled-job recovery re-queues them for another worker.

Repeated signals while shutdown is in progress are logged and ignored.
Shutdown runs once and is always bounded, so it cannot hang.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `SHUTDOWN_GRACE_PERIOD_MS` | `20000` | Time in-flight HTTP requests and BullMQ jobs get to finish. |

Keep the grace period about 10 seconds below your orchestrator's kill
deadline, to leave room for steps 3-6. Kubernetes' default
`terminationGracePeriodSeconds` is 30.

## Adding a resource

Providers keep ownership of the connections they create. They register how to
close each connection, and the coordinator decides when:

```ts
shutdown.register({
  name: 'redis:my-feature', // shown in logs; never a URL or credential
  phase: 'redis',           // 'queues' | 'redis' | 'database'
  close: () => closeRedisClient(client),
});
```

Workers and queues created with `@nestjs/bullmq` (`@Processor`,
`BullModule.registerQueue`) are discovered automatically.
