import { AsyncLocalStorage } from 'async_hooks';

/**
 * Structured principal attached to a request once authentication resolves.
 * Fields are optional so the same shape works for public, API-key and webhook
 * traffic as well as fully authenticated JWT requests.
 */
export interface RequestPrincipal {
  userId?: string;
  organizationId?: string;
  agentId?: string;
  role?: string;
  authMethod?: 'jwt' | 'api-key' | 'webhook' | 'service' | 'public';
}

/**
 * Immutable request-level identifiers and routing metadata captured when the
 * request enters the process. Never mutated after seeding.
 */
export interface RequestIdentity {
  requestId: string;
  correlationId: string;
  traceId: string;
  method: string;
  path: string;
  url: string;
  ip: string | null;
  userAgent: string | null;
  startedAt: number;
}

/**
 * The full, structured object stored in AsyncLocalStorage for the lifetime of a
 * single request. Grouped so consumers can read identity, routing metadata and
 * arbitrary request-scoped values without reaching into raw headers.
 */
export interface RequestContextData {
  identity: RequestIdentity;
  principal?: RequestPrincipal;
  timings: Record<string, number>;
  data: Record<string, unknown>;
}

/**
 * Structured request context storage built on `AsyncLocalStorage`.
 *
 * A single store instance is entered once per HTTP request (see
 * `RequestContextInterceptor`) so that any code running in the request's async
 * flow — controllers, services, guards, filters, queue producers — can read a
 * consistent, typed snapshot of the request without threading arguments
 * through the call tree.
 *
 * The subtle-but-powerful property of `AsyncLocalStorage` is that the context
 * is inherited by every async continuation spawned inside `run()`, which makes
 * it the correct primitive for tracing and request-scoped state in Node.
 */
export class RequestContext {
  private static readonly storage = new AsyncLocalStorage<RequestContextData>();

  /**
   * Enters a request context for the duration of `fn`, propagating it through
   * every asynchronous operation spawned inside.
   */
  static run<R>(data: RequestContextData, fn: () => R): R {
    return this.storage.run(data, fn);
  }

  /** Returns the raw structured store bound to the current async flow. */
  static getStore(): RequestContextData | undefined {
    return this.storage.getStore();
  }

  /** Convenience alias for {@link getStore}. */
  static get(): RequestContextData | undefined {
    return this.getStore();
  }

  static getRequestId(): string | undefined {
    return this.storage.getStore()?.identity.requestId;
  }

  static getCorrelationId(): string | undefined {
    return this.storage.getStore()?.identity.correlationId;
  }

  static getTraceId(): string | undefined {
    return this.storage.getStore()?.identity.traceId;
  }

  static getMethod(): string | undefined {
    return this.storage.getStore()?.identity.method;
  }

  static getPath(): string | undefined {
    return this.storage.getStore()?.identity.path;
  }

  static getStartedAt(): number | undefined {
    return this.storage.getStore()?.identity.startedAt;
  }

  static getPrincipal(): RequestPrincipal | undefined {
    return this.storage.getStore()?.principal;
  }

  static getUserId(): string | undefined {
    return this.storage.getStore()?.principal?.userId;
  }

  static getOrganizationId(): string | undefined {
    return this.storage.getStore()?.principal?.organizationId;
  }

  static getAgentId(): string | undefined {
    return this.storage.getStore()?.principal?.agentId;
  }

  /**
   * Merges a partial principal into the current store. No-op when no context
   * is active so code that runs outside a request never throws.
   */
  static setPrincipal(principal: RequestPrincipal): void {
    const store = this.storage.getStore();
    if (store) {
      store.principal = { ...store.principal, ...principal };
    }
  }

  /**
   * Reads a request-scoped value previously stored with {@link setData}.
   */
  static getData<T = unknown>(key: string): T | undefined {
    return this.storage.getStore()?.data[key] as T | undefined;
  }

  /**
   * Stores an arbitrary request-scoped value keyed by `name`.
   */
  static setData(name: string, value: unknown): void {
    const store = this.storage.getStore();
    if (store) {
      store.data[name] = value;
    }
  }

  /**
   * Records the elapsed time (ms) since the request started under `name`,
   * then stores it in the context `timings` map for observability.
   */
  static markTiming(name: string): void {
    const store = this.storage.getStore();
    if (store) {
      store.timings[name] = Date.now() - store.identity.startedAt;
    }
  }

  /**
   * Reads a recorded timing value (ms) by name, if present.
   */
  static getTiming(name: string): number | undefined {
    return this.storage.getStore()?.timings[name];
  }
}
