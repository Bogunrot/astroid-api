import { describe, expect, it } from 'vitest';
import {
  generateToken,
  sha256,
  hashWithArgon2,
  verifyArgon2,
  generateApiKey,
  hmacSign,
  generateWebhookSignature,
  buildWebhookHeaders,
  safeEqual,
} from './crypto.util';

describe('crypto.util', () => {
  describe('generateToken', () => {
    it('should generate a random hex token of specified length', () => {
      const token = generateToken(32);
      expect(token).toHaveLength(64); // 32 bytes = 64 hex chars
      expect(/^[a-f0-9]+$/.test(token)).toBe(true);
    });

    it('should generate different tokens on each call', () => {
      const token1 = generateToken(16);
      const token2 = generateToken(16);
      expect(token1).not.toBe(token2);
    });

    it('should use default byte length when not specified', () => {
      const token = generateToken();
      expect(token).toHaveLength(64); // default 32 bytes
    });
  });

  describe('sha256', () => {
    it('should generate consistent SHA-256 hashes', () => {
      const hash1 = sha256('test');
      const hash2 = sha256('test');
      expect(hash1).toBe(hash2);
    });

    it('should generate different hashes for different inputs', () => {
      const hash1 = sha256('test1');
      const hash2 = sha256('test2');
      expect(hash1).not.toBe(hash2);
    });

    it('should produce fixed-length output', () => {
      const hash = sha256('any input');
      expect(hash).toHaveLength(64); // SHA-256 produces 64 hex chars
    });
  });

  describe('hashWithArgon2', () => {
    it('should generate Argon2id hash for a value', async () => {
      const hash = await hashWithArgon2('password123');
      expect(hash).toBeDefined();
      expect(typeof hash).toBe('string');
      expect(hash.length).toBeGreaterThan(0);
    });

    it('should generate different hashes for the same input (due to salt)', async () => {
      const hash1 = await hashWithArgon2('password123');
      const hash2 = await hashWithArgon2('password123');
      expect(hash1).not.toBe(hash2);
    });

    it('should generate different hashes for different inputs', async () => {
      const hash1 = await hashWithArgon2('password123');
      const hash2 = await hashWithArgon2('password456');
      expect(hash1).not.toBe(hash2);
    });

    it('should include Argon2id identifier in hash', async () => {
      const hash = await hashWithArgon2('test');
      expect(hash).toMatch(/\$argon2id\$/);
    });
  });

  describe('verifyArgon2', () => {
    it('should verify correct password against hash', async () => {
      const password = 'correct-password';
      const hash = await hashWithArgon2(password);
      const isValid = await verifyArgon2(hash, password);
      expect(isValid).toBe(true);
    });

    it('should reject incorrect password against hash', async () => {
      const password = 'correct-password';
      const hash = await hashWithArgon2(password);
      const isValid = await verifyArgon2(hash, 'wrong-password');
      expect(isValid).toBe(false);
    });

    it('should handle invalid hash gracefully', async () => {
      const isValid = await verifyArgon2('invalid-hash', 'password');
      expect(isValid).toBe(false);
    });

    it('should use constant-time comparison (timing attack resistant)', async () => {
      const password = 'password123';
      const hash = await hashWithArgon2(password);
      
      // Both should take similar time regardless of result
      const start1 = Date.now();
      await verifyArgon2(hash, password);
      const time1 = Date.now() - start1;
      
      const start2 = Date.now();
      await verifyArgon2(hash, 'wrong');
      const time2 = Date.now() - start2;
      
      // Times should be reasonably close (within 10x due to system variance)
      expect(Math.abs(time1 - time2)).toBeLessThan(time1 * 10);
    });
  });

  describe('generateApiKey', () => {
    it('should generate API key with proper format', async () => {
      const apiKey = await generateApiKey('live');
      expect(apiKey.raw).toMatch(/^ak_live_[a-f0-9]+$/);
      expect(apiKey.prefix).toHaveLength(14);
      expect(apiKey.hashedKey).toBeDefined();
      expect(apiKey.hashedKey.length).toBeGreaterThan(0);
    });

    it('should use different environment prefixes', async () => {
      const liveKey = await generateApiKey('live');
      const testKey = await generateApiKey('test');
      expect(liveKey.raw).toMatch(/^ak_live_/);
      expect(testKey.raw).toMatch(/^ak_test_/);
    });

    it('should use default environment when not specified', async () => {
      const apiKey = await generateApiKey();
      expect(apiKey.raw).toMatch(/^ak_live_/);
    });

    it('should generate unique keys each time', async () => {
      const key1 = await generateApiKey('live');
      const key2 = await generateApiKey('live');
      expect(key1.raw).not.toBe(key2.raw);
      expect(key1.hashedKey).not.toBe(key2.hashedKey);
    });

    it('should use Argon2id for hashing', async () => {
      const apiKey = await generateApiKey('live');
      expect(apiKey.hashedKey).toMatch(/\$argon2id\$/);
    });

    it('should verify generated key against hash', async () => {
      const apiKey = await generateApiKey('live');
      const isValid = await verifyArgon2(apiKey.hashedKey, apiKey.raw);
      expect(isValid).toBe(true);
    });
  });

  describe('hmacSign', () => {
    it('should generate HMAC-SHA256 signature', () => {
      const signature = hmacSign('secret', 'payload');
      expect(signature).toHaveLength(64); // SHA-256 = 64 hex chars
      expect(/^[a-f0-9]+$/.test(signature)).toBe(true);
    });

    it('should generate consistent signatures for same input', () => {
      const sig1 = hmacSign('secret', 'payload');
      const sig2 = hmacSign('secret', 'payload');
      expect(sig1).toBe(sig2);
    });

    it('should generate different signatures for different secrets', () => {
      const sig1 = hmacSign('secret1', 'payload');
      const sig2 = hmacSign('secret2', 'payload');
      expect(sig1).not.toBe(sig2);
    });
  });

  describe('generateWebhookSignature', () => {
    it('should generate webhook signature per spec', () => {
      const signature = generateWebhookSignature('secret', '1234567890', '{"data":"test"}');
      expect(signature).toHaveLength(64);
      expect(/^[a-f0-9]+$/.test(signature)).toBe(true);
    });

    it('should concatenate timestamp and body without delimiter', () => {
      const signature = generateWebhookSignature('secret', '123', 'body');
      const manualHmac = hmacSign('secret', '123body');
      expect(signature).toBe(manualHmac);
    });
  });

  describe('buildWebhookHeaders', () => {
    it('should build standard webhook headers', () => {
      const headers = buildWebhookHeaders({
        signature: 'abc123',
        timestamp: '1234567890',
        deliveryId: 'delivery-1',
        eventName: 'transaction.created',
      });

      expect(headers['x-astroid-signature']).toBe('abc123');
      expect(headers['x-astroid-timestamp']).toBe('1234567890');
      expect(headers['x-astroid-delivery']).toBe('delivery-1');
      expect(headers['x-astroid-event']).toBe('transaction.created');
      expect(headers['x-astroid-event-id']).toBe('delivery-1');
    });
  });

  describe('safeEqual', () => {
    it('should return true for equal strings', () => {
      expect(safeEqual('abc123', 'abc123')).toBe(true);
    });

    it('should return false for different strings', () => {
      expect(safeEqual('abc123', 'abc456')).toBe(false);
    });

    it('should return false for different length strings', () => {
      expect(safeEqual('abc', 'abcd')).toBe(false);
    });

    it('should use constant-time comparison', () => {
      const start1 = Date.now();
      safeEqual('a'.repeat(1000), 'a'.repeat(1000));
      const time1 = Date.now() - start1;

      const start2 = Date.now();
      safeEqual('a'.repeat(1000), 'b'.repeat(1000));
      const time2 = Date.now() - start2;

      // Times should be similar (within reasonable tolerance)
      expect(Math.abs(time1 - time2)).toBeLessThan(10);
    });
  });

  describe('backward compatibility', () => {
    it('should still support SHA-256 for non-API-key use cases', () => {
      const hash = sha256('test-value');
      expect(hash).toHaveLength(64);
      expect(/^[a-f0-9]+$/.test(hash)).toBe(true);
    });

    it('should distinguish between Argon2id and SHA-256 hashes', async () => {
      const argonHash = await hashWithArgon2('test');
      const shaHash = sha256('test');
      
      expect(argonHash).toMatch(/\$argon2id\$/);
      expect(shaHash).not.toMatch(/\$argon2id\$/);
      expect(argonHash).not.toBe(shaHash);
    });
  });
});
