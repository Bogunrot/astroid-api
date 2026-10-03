import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyService } from '../api-key.service';
import { ApiKeyRepository } from '../api-key.repository';
import { ConflictException, NotFoundException } from '../../../common/exceptions/domain.exception';
import { hashWithArgon2, sha256 } from '../../../utils/crypto.util';

describe('ApiKeyService', () => {
  let service: ApiKeyService;
  let repository: {
    create: ReturnType<typeof vi.fn>;
    findManyAndCount: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    findByHash: ReturnType<typeof vi.fn>;
    findByPrefix: ReturnType<typeof vi.fn>;
    revoke: ReturnType<typeof vi.fn>;
    touchLastUsed: ReturnType<typeof vi.fn>;
  };

  const orgId = 'org-1';
  const userId = 'user-1';

  beforeEach(() => {
    repository = {
      create: vi.fn(),
      findManyAndCount: vi.fn(),
      findById: vi.fn(),
      findByHash: vi.fn(),
      findByPrefix: vi.fn(),
      revoke: vi.fn(),
      touchLastUsed: vi.fn(),
    };
    service = new ApiKeyService(repository as unknown as ApiKeyRepository);
  });

  describe('create', () => {
    it('creates an API key, hashes it with Argon2id, and returns raw key only once', async () => {
      repository.create.mockImplementation((data) =>
        Promise.resolve({
          id: 'key-123',
          ...data,
          lastUsedAt: null,
          revokedAt: null,
          createdAt: new Date(),
        }),
      );

      const result = await service.create(orgId, userId, {
        name: 'Agent Key',
        permissions: ['transactions:write', 'wallets:read'],
        allowedIps: ['192.168.1.1'],
        expiresInDays: 30,
      });

      expect(result).toMatchObject({
        id: 'key-123',
        name: 'Agent Key',
        permissions: ['transactions:write', 'wallets:read'],
      });
      expect(result.key).toMatch(/^ak_live_[a-f0-9]{48}$/);
      expect(result.prefix).toBe(result.key.slice(0, 14));
      expect(result.expiresAt).toBeInstanceOf(Date);

      // Verify the stored hash is Argon2id format
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: orgId,
          createdById: userId,
          name: 'Agent Key',
          prefix: result.prefix,
          hashedKey: expect.stringMatching(/\$argon2id\$/),
          permissions: ['transactions:write', 'wallets:read'],
          allowedIps: ['192.168.1.1'],
        }),
      );
    });

    it('creates an API key without expiry when expiresInDays is not provided', async () => {
      repository.create.mockImplementation((data) =>
        Promise.resolve({
          id: 'key-456',
          ...data,
          lastUsedAt: null,
          revokedAt: null,
          createdAt: new Date(),
        }),
      );

      const result = await service.create(orgId, userId, {
        name: 'Permanent Key',
        permissions: [],
        allowedIps: [],
      });

      expect(result.expiresAt).toBeNull();
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          expiresAt: null,
        }),
      );
    });
  });

  describe('list', () => {
    it('returns paginated items for an organization', async () => {
      const mockItems = [
        {
          id: 'key-1',
          name: 'Key 1',
          prefix: 'ak_live_123456',
          permissions: ['transactions:read'],
        },
      ];
      repository.findManyAndCount.mockResolvedValue({ items: mockItems, total: 1 });

      const result = await service.list(orgId, {
        page: 1,
        limit: 20,
        sort: 'createdAt',
        order: 'desc',
      });

      expect(result.items).toEqual(mockItems);
      expect(result.meta.total).toBe(1);
      expect(repository.findManyAndCount).toHaveBeenCalledWith(
        { organizationId: orgId },
        expect.objectContaining({ skip: 0, take: 20 }),
      );
    });

    it('applies search filter when query.search is provided', async () => {
      repository.findManyAndCount.mockResolvedValue({ items: [], total: 0 });

      await service.list(orgId, {
        page: 1,
        limit: 20,
        sort: 'createdAt',
        order: 'desc',
        search: 'agent',
      });

      expect(repository.findManyAndCount).toHaveBeenCalledWith(
        {
          organizationId: orgId,
          name: { contains: 'agent', mode: 'insensitive' },
        },
        expect.anything(),
      );
    });
  });

  describe('revoke', () => {
    it('revokes an active API key', async () => {
      repository.findById.mockResolvedValue({
        id: 'key-1',
        organizationId: orgId,
        revokedAt: null,
      });
      repository.revoke.mockResolvedValue({ id: 'key-1', revokedAt: new Date() });

      const result = await service.revoke(orgId, 'key-1');

      expect(result).toEqual({ id: 'key-1', revoked: true });
      expect(repository.revoke).toHaveBeenCalledWith('key-1');
    });

    it('throws NotFoundException when key does not exist', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.revoke(orgId, 'non-existent')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws ConflictException when key is already revoked', async () => {
      repository.findById.mockResolvedValue({
        id: 'key-1',
        organizationId: orgId,
        revokedAt: new Date(),
      });

      await expect(service.revoke(orgId, 'key-1')).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('verify', () => {
    it('verifies key with Argon2id hash', async () => {
      const rawSecret = 'ak_live_abcdef1234567890abcdef1234567890abcdef12';
      const argonHash = await hashWithArgon2(rawSecret);
      
      const mockKey = {
        id: 'key-1',
        name: 'Agent Key',
        hashedKey: argonHash,
        permissions: ['transactions:write'],
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86400000),
      };
      
      repository.findByPrefix.mockResolvedValue([mockKey]);
      repository.touchLastUsed.mockResolvedValue({ ...mockKey, lastUsedAt: new Date() });

      const verified = await service.verify(rawSecret);

      expect(verified).toEqual(mockKey);
      expect(repository.findByPrefix).toHaveBeenCalledWith(rawSecret.slice(0, 14));
      expect(repository.touchLastUsed).toHaveBeenCalledWith('key-1');
    });

    it('verifies legacy key with SHA-256 hash for backward compatibility', async () => {
      const rawSecret = 'ak_live_abcdef1234567890abcdef1234567890abcdef12';
      const shaHash = sha256(rawSecret);
      
      const mockKey = {
        id: 'key-legacy',
        name: 'Legacy Key',
        hashedKey: shaHash,
        permissions: ['transactions:read'],
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86400000),
      };
      
      repository.findByPrefix.mockResolvedValue([mockKey]);
      repository.touchLastUsed.mockResolvedValue({ ...mockKey, lastUsedAt: new Date() });

      const verified = await service.verify(rawSecret);

      expect(verified).toEqual(mockKey);
      expect(repository.findByPrefix).toHaveBeenCalledWith(rawSecret.slice(0, 14));
      expect(repository.touchLastUsed).toHaveBeenCalledWith('key-legacy');
    });

    it('returns null for empty or invalid raw key input', async () => {
      expect(await service.verify('')).toBeNull();
      expect(await service.verify('   ')).toBeNull();
      expect(await service.verify(null as unknown as string)).toBeNull();
      expect(await service.verify(undefined as unknown as string)).toBeNull();
      expect(repository.findByPrefix).not.toHaveBeenCalled();
    });

    it('returns null when no keys found with matching prefix', async () => {
      repository.findByPrefix.mockResolvedValue([]);

      const verified = await service.verify('ak_live_unknownkey');

      expect(verified).toBeNull();
      expect(repository.touchLastUsed).not.toHaveBeenCalled();
    });

    it('returns null when key has been revoked', async () => {
      const rawSecret = 'ak_live_abcdef1234567890abcdef1234567890abcdef12';
      const argonHash = await hashWithArgon2(rawSecret);
      
      repository.findByPrefix.mockResolvedValue([
        {
          id: 'key-revoked',
          hashedKey: argonHash,
          revokedAt: new Date(Date.now() - 10000),
        },
      ]);

      const verified = await service.verify(rawSecret);

      expect(verified).toBeNull();
      expect(repository.touchLastUsed).not.toHaveBeenCalled();
    });

    it('returns null when key has expired', async () => {
      const rawSecret = 'ak_live_abcdef1234567890abcdef1234567890abcdef12';
      const argonHash = await hashWithArgon2(rawSecret);
      
      repository.findByPrefix.mockResolvedValue([
        {
          id: 'key-expired',
          hashedKey: argonHash,
          revokedAt: null,
          expiresAt: new Date(Date.now() - 5000),
        },
      ]);

      const verified = await service.verify(rawSecret);

      expect(verified).toBeNull();
      expect(repository.touchLastUsed).not.toHaveBeenCalled();
    });

    it('still returns key if touchLastUsed throws a transient error', async () => {
      const rawSecret = 'ak_live_abcdef1234567890abcdef1234567890abcdef12';
      const argonHash = await hashWithArgon2(rawSecret);
      
      const mockKey = {
        id: 'key-1',
        hashedKey: argonHash,
        revokedAt: null,
        expiresAt: null,
      };
      
      repository.findByPrefix.mockResolvedValue([mockKey]);
      repository.touchLastUsed.mockRejectedValue(new Error('DB connection busy'));

      const verified = await service.verify(rawSecret);

      expect(verified).toEqual(mockKey);
    });

    it('tries multiple keys with same prefix until match is found', async () => {
      const rawSecret = 'ak_live_abcdef1234567890abcdef1234567890abcdef12';
      const argonHash = await hashWithArgon2(rawSecret);
      
      const wrongKey = {
        id: 'key-wrong',
        hashedKey: await hashWithArgon2('different-key'),
        revokedAt: null,
        expiresAt: null,
      };
      
      const correctKey = {
        id: 'key-correct',
        hashedKey: argonHash,
        permissions: ['transactions:write'],
        revokedAt: null,
        expiresAt: null,
      };
      
      repository.findByPrefix.mockResolvedValue([wrongKey, correctKey]);
      repository.touchLastUsed.mockResolvedValue({ ...correctKey, lastUsedAt: new Date() });

      const verified = await service.verify(rawSecret);

      expect(verified).toEqual(correctKey);
      expect(repository.touchLastUsed).toHaveBeenCalledWith('key-correct');
    });
  });
});
