import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Request } from 'express';
import { ApiKeyStrategy, HeaderApiKeyPassportStrategy } from '../api-key.strategy';
import { ApiKeyService } from '../../developer/api-key.service';
import { UnauthorizedException } from '../../../common/exceptions/domain.exception';
import { UserRole } from '@prisma/client';

describe('ApiKeyStrategy', () => {
  let strategy: ApiKeyStrategy;
  let apiKeyService: {
    verify: ReturnType<typeof vi.fn>;
  };

  const rawKey = 'ak_live_1234567890abcdef1234567890abcdef12345678';
  const mockApiKey = {
    id: 'key-123',
    organizationId: 'org-456',
    createdById: 'user-789',
    name: 'Test Key',
    prefix: 'ak_live_123456',
    permissions: ['transactions:write', 'policies:read'],
    allowedIps: ['192.168.1.0/24'],
  };

  beforeEach(() => {
    apiKeyService = {
      verify: vi.fn(),
    };
    strategy = new ApiKeyStrategy(apiKeyService as unknown as ApiKeyService);
  });

  describe('validate', () => {
    it('returns an AuthenticatedApiKey principal for a valid key', async () => {
      apiKeyService.verify.mockResolvedValue(mockApiKey);
      const req = {} as Request;

      const result = await strategy.validate(rawKey, req);

      expect(apiKeyService.verify).toHaveBeenCalledWith(rawKey);
      expect(result).toEqual({
        id: 'key-123',
        keyId: 'key-123',
        apiKeyId: 'key-123',
        organizationId: 'org-456',
        createdById: 'user-789',
        name: 'Test Key',
        prefix: 'ak_live_123456',
        permissions: ['transactions:write', 'policies:read'],
        scopes: ['transactions:write', 'policies:read'],
        allowedIps: ['192.168.1.0/24'],
        isApiKey: true,
        role: UserRole.DEVELOPER,
      });
      expect((req as unknown as { apiKey: unknown }).apiKey).toEqual(mockApiKey);
    });

    it('throws UnauthorizedException when apiKeyService.verify returns null', async () => {
      apiKeyService.verify.mockResolvedValue(null);

      await expect(strategy.validate('ak_live_invalid')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('HeaderApiKeyPassportStrategy authenticate', () => {
    let passportStrategy: HeaderApiKeyPassportStrategy;

    beforeEach(() => {
      passportStrategy = new HeaderApiKeyPassportStrategy();
    });

    it('extracts key from x-api-key header and succeeds when validate resolves', async () => {
      const mockReq = {
        headers: { 'x-api-key': rawKey },
      } as unknown as Request;

      const principal = { id: 'key-123', organizationId: 'org-456' };
      const validateSpy = vi.fn().mockResolvedValue(principal);
      (passportStrategy as unknown as { validate: typeof validateSpy }).validate = validateSpy;

      const successSpy = vi.fn();
      passportStrategy.success = successSpy;

      passportStrategy.authenticate(mockReq);

      await vi.waitFor(() => {
        expect(validateSpy).toHaveBeenCalledWith(rawKey, mockReq);
        expect(successSpy).toHaveBeenCalledWith(principal);
      });
    });

    it('extracts key from Authorization header formatted as ApiKey <key>', async () => {
      const mockReq = {
        headers: { authorization: `ApiKey ${rawKey}` },
      } as unknown as Request;

      const principal = { id: 'key-123' };
      const validateSpy = vi.fn().mockResolvedValue(principal);
      (passportStrategy as unknown as { validate: typeof validateSpy }).validate = validateSpy;

      const successSpy = vi.fn();
      passportStrategy.success = successSpy;

      passportStrategy.authenticate(mockReq);

      await vi.waitFor(() => {
        expect(validateSpy).toHaveBeenCalledWith(rawKey, mockReq);
        expect(successSpy).toHaveBeenCalledWith(principal);
      });
    });

    it('extracts key from Authorization header formatted as Bearer ak_<key>', async () => {
      const mockReq = {
        headers: { authorization: `Bearer ${rawKey}` },
      } as unknown as Request;

      const principal = { id: 'key-123' };
      const validateSpy = vi.fn().mockResolvedValue(principal);
      (passportStrategy as unknown as { validate: typeof validateSpy }).validate = validateSpy;

      const successSpy = vi.fn();
      passportStrategy.success = successSpy;

      passportStrategy.authenticate(mockReq);

      await vi.waitFor(() => {
        expect(validateSpy).toHaveBeenCalledWith(rawKey, mockReq);
        expect(successSpy).toHaveBeenCalledWith(principal);
      });
    });

    it('fails when no API key header is present', () => {
      const mockReq = {
        headers: {},
      } as unknown as Request;

      const failSpy = vi.fn();
      passportStrategy.fail = failSpy;

      passportStrategy.authenticate(mockReq);

      expect(failSpy).toHaveBeenCalledWith(expect.any(UnauthorizedException), 401);
    });

    it('fails when validate returns null or throws UnauthorizedException', async () => {
      const mockReq = {
        headers: { 'x-api-key': 'ak_live_bad' },
      } as unknown as Request;

      const validateSpy = vi.fn().mockRejectedValue(new UnauthorizedException('Invalid API key'));
      (passportStrategy as unknown as { validate: typeof validateSpy }).validate = validateSpy;

      const failSpy = vi.fn();
      passportStrategy.fail = failSpy;

      passportStrategy.authenticate(mockReq);

      await vi.waitFor(() => {
        expect(failSpy).toHaveBeenCalledWith(expect.any(UnauthorizedException), 401);
      });
    });
  });
});
