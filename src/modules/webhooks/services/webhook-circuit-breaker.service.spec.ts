import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  WebhookCircuitBreakerService,
  WebhookCircuitState,
} from './webhook-circuit-breaker.service';

/**
 * The breaker is exercised through its in-memory fallback path (Redis is not
 * available in unit tests), which mirrors the Redis semantics with identical
 * state transitions.
 */
describe('WebhookCircuitBreakerService', () => {
  let breaker: WebhookCircuitBreakerService;
  const URL_A = 'https://failing.example.com/hook';
  const URL_B = 'https://healthy.example.com/hook';

  beforeEach(() => {
    vi.useFakeTimers();
    // Threshold 3 keeps trip scenarios short; the production default is 5.
    breaker = new WebhookCircuitBreakerService(3, 10_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const fail = (url: string) => breaker.recordFailure(url, new Error('HTTP 500'));
  const succeed = (url: string) => breaker.recordSuccess(url);

  describe('state transitions', () => {
    it('starts CLOSED and allows delivery', async () => {
      const report = await breaker.getReport(URL_A);
      expect(report.state).toBe(WebhookCircuitState.CLOSED);
      expect(await breaker.isDeliveryAllowed(URL_A)).toBe(true);
    });

    it('stays CLOSED below the failure threshold', async () => {
      await fail(URL_A);
      await fail(URL_A);

      const report = await breaker.getReport(URL_A);
      expect(report.state).toBe(WebhookCircuitState.CLOSED);
      expect(report.consecutiveFailures).toBe(2);
      expect(await breaker.isDeliveryAllowed(URL_A)).toBe(true);
    });

    it('trips OPEN after the threshold of consecutive failures', async () => {
      await fail(URL_A);
      await fail(URL_A);
      await fail(URL_A);

      const report = await breaker.getReport(URL_A);
      expect(report.state).toBe(WebhookCircuitState.OPEN);
      expect(report.consecutiveFailures).toBe(3);
      expect(await breaker.isDeliveryAllowed(URL_A)).toBe(false);
      expect(report.remainingOpenMs).toBeGreaterThan(0);
    });

    it('tracks domains independently', async () => {
      await fail(URL_A);
      await fail(URL_A);
      await fail(URL_A);

      expect((await breaker.getReport(URL_A)).state).toBe(WebhookCircuitState.OPEN);
      expect((await breaker.getReport(URL_B)).state).toBe(WebhookCircuitState.CLOSED);
      expect(await breaker.isDeliveryAllowed(URL_B)).toBe(true);
    });

    it('normalizes hosts so paths do not split the circuit', async () => {
      await fail('https://example.com/a');
      await fail('https://example.com/b');
      await fail('https://example.com/c');

      expect((await breaker.getReport('https://example.com/anything')).state).toBe(
        WebhookCircuitState.OPEN,
      );
    });

    it('a success resets the consecutive failure counter while CLOSED', async () => {
      await fail(URL_A);
      await fail(URL_A);
      await succeed(URL_A);
      await fail(URL_A);
      await fail(URL_A);

      expect((await breaker.getReport(URL_A)).state).toBe(WebhookCircuitState.CLOSED);
    });

    it('half-opens after the open-state TTL elapses and allows a trial', async () => {
      await fail(URL_A);
      await fail(URL_A);
      await fail(URL_A);
      expect(await breaker.isDeliveryAllowed(URL_A)).toBe(false);

      // Advance past the 10s open window.
      vi.advanceTimersByTime(10_001);

      expect(await breaker.isDeliveryAllowed(URL_A)).toBe(true);
      expect((await breaker.getReport(URL_A)).state).toBe(WebhookCircuitState.HALF_OPEN);
    });

    it('a failed trial immediately reopens the circuit', async () => {
      await fail(URL_A);
      await fail(URL_A);
      await fail(URL_A);
      vi.advanceTimersByTime(10_001);

      // Trial delivery goes through, then fails again.
      expect(await breaker.isDeliveryAllowed(URL_A)).toBe(true);
      await fail(URL_A);

      expect((await breaker.getReport(URL_A)).state).toBe(WebhookCircuitState.OPEN);
      expect(await breaker.isDeliveryAllowed(URL_A)).toBe(false);
    });

    it('closes again after consecutive successful trials while HALF_OPEN', async () => {
      await fail(URL_A);
      await fail(URL_A);
      await fail(URL_A);
      vi.advanceTimersByTime(10_001);

      await breaker.isDeliveryAllowed(URL_A); // transition to HALF_OPEN
      await succeed(URL_A);
      expect((await breaker.getReport(URL_A)).state).toBe(WebhookCircuitState.HALF_OPEN);
      await succeed(URL_A);
      expect((await breaker.getReport(URL_A)).state).toBe(WebhookCircuitState.CLOSED);
      expect((await breaker.getReport(URL_A)).consecutiveFailures).toBe(0);
    });

    it('reset force-closes the circuit', async () => {
      await fail(URL_A);
      await fail(URL_A);
      await fail(URL_A);
      expect((await breaker.getReport(URL_A)).state).toBe(WebhookCircuitState.OPEN);

      await breaker.reset(URL_A);
      expect((await breaker.getReport(URL_A)).state).toBe(WebhookCircuitState.CLOSED);
      expect(await breaker.isDeliveryAllowed(URL_A)).toBe(true);
    });

    it('getAllReports lists tracked domains', async () => {
      await fail(URL_A);
      const reports = await breaker.getAllReports();
      expect(reports.some((r) => r.host === 'failing.example.com')).toBe(true);
    });
  });

  describe('host extraction edge cases', () => {
    it('falls back to a stable key for malformed URLs', async () => {
      await expect(breaker.isDeliveryAllowed('not-a-url')).resolves.toBe(true);
      const report = await breaker.getReport('not-a-url');
      expect(report.host).toBe('unknown');
    });
  });
});
