import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Job, UnrecoverableError } from 'bullmq';
import { WebhooksProcessor } from './webhooks.processor';
import { WebhookJobData } from './types/webhook-job.types';
import { createHmac } from 'crypto';
import {
  WebhookCircuitBreakerService,
} from './services/webhook-circuit-breaker.service';

describe('WebhooksProcessor', () => {
  let processor: WebhooksProcessor;
  let mockPrisma: Record<string, unknown>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  const WEBHOOK_SECRET = 'whsec_test-secret-key';
  const WEBHOOK_URL = 'https://example.com/webhook';
  const WEBHOOK_ID = 'wh-123';
  const ORG_ID = 'org-456';
  const EVENT_ID = 'txn-789-2024-01-01';

  const createJobData = (overrides: Partial<WebhookJobData> = {}): WebhookJobData => ({
    webhookId: WEBHOOK_ID,
    organizationId: ORG_ID,
    url: WEBHOOK_URL,
    secret: WEBHOOK_SECRET,
    eventName: 'transaction.completed',
    payload: { event: 'transaction.completed', data: { transactionId: 'txn-123' } },
    eventId: EVENT_ID,
    ...overrides,
  });

  const createMockJob = (overrides: Partial<Job<WebhookJobData>> = {}): Job<WebhookJobData> =>
    ({
      id: 'job-1',
      data: createJobData(),
      attemptsMade: 0,
      ...overrides,
    }) as unknown as Job<WebhookJobData>;

  beforeEach(() => {
    mockPrisma = {};
    // Access private property via type assertion
    processor = new WebhooksProcessor(mockPrisma as never);
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('successful delivery', () => {
    it('sends a POST with correct headers including HMAC signature', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('OK'),
      });

      const job = createMockJob();
      await processor.process(job);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe(WEBHOOK_URL);
      expect(options.method).toBe('POST');
      expect(options.headers['content-type']).toBe('application/json');
      expect(options.headers['user-agent']).toBe('Astroid-Webhook-Bot/1.0');
      expect(options.headers['x-astroid-event']).toBe('transaction.completed');
      expect(options.headers['x-astroid-event-id']).toBe(EVENT_ID);
      // New required headers per spec: X-Astroid-Delivery and timestamp
      expect(options.headers['x-astroid-delivery']).toBe(EVENT_ID);
      expect(options.headers['x-astroid-timestamp']).toBeDefined();
      expect(options.headers['x-astroid-timestamp']).toMatch(/^\d+$/);

      // Verify HMAC-SHA256 signature = HMAC(secret, timestamp + body)
      const body = options.body;
      const timestamp = options.headers['x-astroid-timestamp'];
      const expectedSignature = createHmac('sha256', WEBHOOK_SECRET)
        .update(`${timestamp}.${body}`)
        .digest('hex');
      expect(options.headers['x-astroid-signature']).toBe(expectedSignature);
    });

    it('returns success result with status code', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('OK'),
      });

      const result = await processor.process(createMockJob());
      expect(result).toEqual({ success: true, statusCode: 200 });
    });

    it('accepts 201 as success', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 201,
        text: () => Promise.resolve('Created'),
      });

      const result = await processor.process(createMockJob());
      expect(result).toEqual({ success: true, statusCode: 201 });
    });

    it('includes a 5-second timeout on fetch', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('OK'),
      });

      await processor.process(createMockJob());
      const [, options] = fetchSpy.mock.calls[0];
      expect(options.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('non-transient error handling (throws UnrecoverableError)', () => {
    const nonTransientStatuses = [400, 401, 403, 404, 422];

    for (const status of nonTransientStatuses) {
      it(`throws UnrecoverableError for HTTP ${status}`, async () => {
        fetchSpy.mockResolvedValue({
          ok: false,
          status,
          text: () => Promise.resolve(`Error ${status}`),
        });

        const job = createMockJob();
        await expect(processor.process(job)).rejects.toThrow(UnrecoverableError);
      });
    }

    it('does not throw UnrecoverableError for 500 (transient)', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      const job = createMockJob();
      await expect(processor.process(job)).rejects.toThrow('HTTP 500');
      await expect(processor.process(job)).rejects.not.toThrow(UnrecoverableError);
    });

    it('does not throw UnrecoverableError for 502 (transient)', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 502,
        text: () => Promise.resolve('Bad Gateway'),
      });

      const job = createMockJob();
      await expect(processor.process(job)).rejects.toThrow('HTTP 502');
    });

    it('does not throw UnrecoverableError for 503 (transient)', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve('Service Unavailable'),
      });

      const job = createMockJob();
      await expect(processor.process(job)).rejects.toThrow('HTTP 503');
    });
  });

  describe('transient error handling (retriable)', () => {
    it('throws a regular error for transient 5xx (allows BullMQ retry)', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      const job = createMockJob();
      let threw = false;
      try {
        await processor.process(job);
      } catch (error) {
        threw = true;
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(UnrecoverableError);
        expect((error as Error).message).toContain('HTTP 500');
      }
      expect(threw).toBe(true);
    });

    it('retries on network timeout', async () => {
      fetchSpy.mockRejectedValue(new Error('The operation was aborted'));

      const job = createMockJob();
      let threw = false;
      try {
        await processor.process(job);
      } catch (error) {
        threw = true;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('aborted');
      }
      expect(threw).toBe(true);
    });

    it('retries on DNS resolution failure', async () => {
      fetchSpy.mockRejectedValue(new Error('getaddrinfo ENOTFOUND example.com'));

      const job = createMockJob();
      await expect(processor.process(job)).rejects.toThrow('ENOTFOUND');
    });
  });

  describe('attempt tracking', () => {
    it('tracks attemptsMade correctly', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('OK'),
      });

      // First attempt (attemptsMade = 0)
      const job0 = createMockJob({ attemptsMade: 0 } as Partial<Job<WebhookJobData>>);
      const result = await processor.process(job0);
      expect(result.success).toBe(true);
    });

    it('rejects on last attempt with transient error', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve('Service Unavailable'),
      });

      // Attempt 5 of 5 (attemptsMade = 4, which means this is the last attempt)
      const job = createMockJob({ attemptsMade: 4 } as Partial<Job<WebhookJobData>>);
      await expect(processor.process(job)).rejects.toThrow('HTTP 503');
    });
  });

  describe('per-domain circuit breaker (issue #219)', () => {
    let breaker: WebhookCircuitBreakerService;

    beforeEach(() => {
      breaker = new WebhookCircuitBreakerService(2, 10_000);
      processor = new WebhooksProcessor(
        mockPrisma as never,
        undefined,
        undefined,
        breaker,
      );
    });

    it('records failures and trips the circuit after consecutive HTTP 500s', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      await expect(processor.process(createMockJob())).rejects.toThrow('HTTP 500');
      await expect(processor.process(createMockJob())).rejects.toThrow('HTTP 500');

      const report = await breaker.getReport(WEBHOOK_URL);
      expect(report.state).toBe('OPEN');
      expect(report.consecutiveFailures).toBe(2);
    });

    it('fail-fasts without calling fetch while the circuit is OPEN', async () => {
      await breaker.recordFailure(WEBHOOK_URL, new Error('HTTP 500'));
      await breaker.recordFailure(WEBHOOK_URL, new Error('HTTP 500'));

      await expect(processor.process(createMockJob())).rejects.toThrow('Circuit open');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('records successes and keeps the circuit CLOSED on healthy delivery', async () => {
      fetchSpy.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('OK') });

      await processor.process(createMockJob());

      const report = await breaker.getReport(WEBHOOK_URL);
      expect(report.state).toBe('CLOSED');
      expect(report.consecutiveFailures).toBe(0);
    });

    it('allows delivery again after the circuit half-opens and delivery succeeds', async () => {
      vi.useFakeTimers();
      try {
        fetchSpy.mockResolvedValue({
          ok: false,
          status: 500,
          text: () => Promise.resolve('Internal Server Error'),
        });
        await expect(processor.process(createMockJob())).rejects.toThrow('HTTP 500');
        await expect(processor.process(createMockJob())).rejects.toThrow('HTTP 500');
        expect((await breaker.getReport(WEBHOOK_URL)).state).toBe('OPEN');

        // Advance past the open window, then deliver successfully.
        vi.advanceTimersByTime(10_001);
        fetchSpy.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('OK') });
        expect((await breaker.isDeliveryAllowed(WEBHOOK_URL)) as boolean).toBe(true);
        await processor.process(createMockJob());

        const report = await breaker.getReport(WEBHOOK_URL);
        expect(['HALF_OPEN', 'CLOSED']).toContain(report.state);
      } finally {
        vi.useRealTimers();
      }
    });

    it('deliveries to a different domain are unaffected by an OPEN circuit', async () => {
      fetchSpy.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('OK') });

      await breaker.recordFailure(WEBHOOK_URL, new Error('HTTP 500'));
      await breaker.recordFailure(WEBHOOK_URL, new Error('HTTP 500'));

      const otherUrlJob = createMockJob({
        data: createJobData({ url: 'https://other-domain.com/hook' }),
      });
      const result = await processor.process(otherUrlJob);
      expect(result.success).toBe(true);
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(fetchSpy.mock.calls[0][0]).toBe('https://other-domain.com/hook');
    });
  });
});
