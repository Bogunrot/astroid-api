import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Agent, AgentRole, AgentStatus, Prisma, Wallet } from '@prisma/client';
import { AgentService } from './agent.service';
import { AgentRepository } from './agent.repository';
import { EventBusService } from '../../events/event-bus.service';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { ConflictException, NotFoundException } from '../../common/exceptions/domain.exception';
import { DomainEventName } from '../../events/event-names';

describe('AgentService', () => {
  let service: AgentService;
  let repository: {
    create: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    findManyAndCount: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    softDelete: ReturnType<typeof vi.fn>;
    findWalletInOrg: ReturnType<typeof vi.fn>;
  };
  let eventBus: { emit: ReturnType<typeof vi.fn> };
  let encryptionService: EncryptionService;

  const orgId = '018f0000-0000-7000-8000-000000000001';
  const actorId = '018f0000-0000-7000-8000-000000000002';
  const agentId = '018f0000-0000-7000-8000-000000000003';
  const walletId = '018f0000-0000-7000-8000-000000000004';

  beforeEach(() => {
    encryptionService = new EncryptionService();
    encryptionService.onModuleInit();

    repository = {
      create: vi.fn(),
      findById: vi.fn(),
      findManyAndCount: vi.fn(),
      update: vi.fn(),
      softDelete: vi.fn(),
      findWalletInOrg: vi.fn(),
    };

    eventBus = {
      emit: vi.fn().mockResolvedValue(undefined),
    };

    service = new AgentService(
      repository as unknown as AgentRepository,
      eventBus as unknown as EventBusService,
      encryptionService,
    );
  });

  describe('create', () => {
    it('should encrypt sensitive metadata before persistence and return decrypted agent', async () => {
      const input = {
        name: 'Autonomous Trader',
        description: 'Automated Stellar trading agent',
        role: AgentRole.FINANCE,
        capabilities: ['payments', 'trade'],
        metadata: {
          privateKey: 'S_STELLAR_PRIVATE_KEY_12345',
          apiKey: 'ak_live_secret_key_67890',
          strategy: 'mean-reversion',
        },
      };

      let storedData: Prisma.AgentCreateInput = {
        name: '',
        organization: { connect: { id: orgId } },
      };

      repository.create.mockImplementation(async (data: Prisma.AgentCreateInput) => {
        storedData = data;
        return {
          id: agentId,
          organizationId: orgId,
          primaryWalletId: null,
          name: data.name,
          description: data.description ?? null,
          provider: data.provider ?? null,
          model: data.model ?? null,
          role: data.role ?? AgentRole.CUSTOM,
          status: AgentStatus.ACTIVE,
          capabilities: (data.capabilities as string[]) ?? [],
          metadata: data.metadata as Prisma.JsonValue,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        } as Agent;
      });

      const result = await service.create(orgId, actorId, input);

      // Verify that sensitive fields in stored repository payload were encrypted
      const storedMeta = storedData.metadata as Record<string, string>;
      expect(encryptionService.isEncrypted(storedMeta.privateKey)).toBe(true);
      expect(encryptionService.isEncrypted(storedMeta.apiKey)).toBe(true);
      expect(storedMeta.strategy).toBe('mean-reversion');

      // Verify returned result has decrypted sensitive fields
      expect(result.metadata).toEqual(input.metadata);
      const resultMeta = result.metadata as Record<string, string>;
      expect(resultMeta.privateKey).toBe('S_STELLAR_PRIVATE_KEY_12345');

      // Verify eventBus was called
      expect(eventBus.emit).toHaveBeenCalledWith(
        DomainEventName.AgentRegistered,
        { agentId, name: input.name, role: input.role },
        { organizationId: orgId, actorId, aggregateType: 'agent', aggregateId: agentId },
      );
    });
  });

  describe('getOrThrow', () => {
    it('should retrieve and decrypt agent metadata', async () => {
      const plainMetadata = {
        privateKey: 'S_SECRET_KEY',
        env: 'production',
      };
      const encryptedMetadata = service.encryptAgentMetadata(plainMetadata);

      repository.findById.mockResolvedValue({
        id: agentId,
        organizationId: orgId,
        primaryWalletId: null,
        name: 'Research Bot',
        description: null,
        provider: 'openai',
        model: 'gpt-4o',
        role: AgentRole.RESEARCH,
        status: AgentStatus.ACTIVE,
        capabilities: [],
        metadata: encryptedMetadata as Prisma.JsonValue,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      } as Agent);

      const agent = await service.getOrThrow(orgId, agentId);

      expect(agent.id).toBe(agentId);
      expect(agent.metadata).toEqual(plainMetadata);
      const meta = agent.metadata as Record<string, string>;
      expect(meta.privateKey).toBe('S_SECRET_KEY');
    });

    it('should throw NotFoundException if agent does not exist', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.getOrThrow(orgId, 'missing-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    it('should encrypt sensitive metadata updates before persistence and return decrypted agent', async () => {
      const existingEncryptedMetadata = service.encryptAgentMetadata({
        privateKey: 'OLD_KEY',
      });

      repository.findById.mockResolvedValue({
        id: agentId,
        organizationId: orgId,
        primaryWalletId: null,
        name: 'Old Name',
        description: null,
        provider: null,
        model: null,
        role: AgentRole.CUSTOM,
        status: AgentStatus.ACTIVE,
        capabilities: [],
        metadata: existingEncryptedMetadata as Prisma.JsonValue,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      } as Agent);

      const newMetadata = {
        privateKey: 'NEW_ROTATED_KEY',
        apiKey: 'ak_new_123',
      };

      let updatePayload: Prisma.AgentUpdateInput = {};
      repository.update.mockImplementation(
        async (id: string, data: Prisma.AgentUpdateInput) => {
          updatePayload = data;
          return {
            id,
            organizationId: orgId,
            primaryWalletId: null,
            name: data.name as string,
            description: null,
            provider: null,
            model: null,
            role: AgentRole.CUSTOM,
            status: AgentStatus.ACTIVE,
            capabilities: [],
            metadata: data.metadata as Prisma.JsonValue,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          } as Agent;
        },
      );

      const updated = await service.update(orgId, actorId, agentId, {
        name: 'Updated Name',
        metadata: newMetadata,
      });

      const updatedMeta = updatePayload.metadata as Record<string, string>;
      expect(encryptionService.isEncrypted(updatedMeta.privateKey)).toBe(true);
      expect(encryptionService.isEncrypted(updatedMeta.apiKey)).toBe(true);

      const resMeta = updated.metadata as Record<string, string>;
      expect(resMeta.privateKey).toBe('NEW_ROTATED_KEY');
      expect(resMeta.apiKey).toBe('ak_new_123');

      expect(eventBus.emit).toHaveBeenCalledWith(
        DomainEventName.AgentUpdated,
        { agentId },
        { organizationId: orgId, actorId, aggregateType: 'agent', aggregateId: agentId },
      );
    });
  });

  describe('list', () => {
    it('should return paginated list of decrypted agents', async () => {
      const encMetadata = service.encryptAgentMetadata({ secretKey: 'SECRET_1' });
      repository.findManyAndCount.mockResolvedValue({
        items: [
          {
            id: agentId,
            organizationId: orgId,
            primaryWalletId: null,
            name: 'Agent 1',
            description: null,
            provider: null,
            model: null,
            role: AgentRole.FINANCE,
            status: AgentStatus.ACTIVE,
            capabilities: [],
            metadata: encMetadata as Prisma.JsonValue,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          } as Agent,
        ],
        total: 1,
      });

      const result = await service.list(orgId, {
        offset: 0,
        page: 1,
        limit: 10,
        sort: 'createdAt',
        order: 'desc',
      });

      expect(result.items.length).toBe(1);
      const meta = result.items[0].metadata as Record<string, string>;
      expect(meta.secretKey).toBe('SECRET_1');
    });
  });

  describe('assignWallet', () => {
    it('should assign wallet and return agent', async () => {
      repository.findById.mockResolvedValue({
        id: agentId,
        organizationId: orgId,
        primaryWalletId: null,
        name: 'Agent 1',
        description: null,
        provider: null,
        model: null,
        role: AgentRole.FINANCE,
        status: AgentStatus.ACTIVE,
        capabilities: [],
        metadata: {} as Prisma.JsonValue,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      } as Agent);

      repository.findWalletInOrg.mockResolvedValue({
        id: walletId,
        organizationId: orgId,
        agentId: null,
        stellarAddress: 'G...',
        label: null,
        walletType: 'AGENT',
        network: 'TESTNET',
        status: 'ACTIVE',
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      } as Wallet);

      repository.update.mockResolvedValue({
        id: agentId,
        organizationId: orgId,
        primaryWalletId: walletId,
        name: 'Agent 1',
        description: null,
        provider: null,
        model: null,
        role: AgentRole.FINANCE,
        status: AgentStatus.ACTIVE,
        capabilities: [],
        metadata: {} as Prisma.JsonValue,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      } as Agent);

      const res = await service.assignWallet(orgId, actorId, agentId, { walletId });
      expect(res.primaryWalletId).toBe(walletId);
    });

    it('should throw ConflictException if wallet is already owned by another agent', async () => {
      repository.findById.mockResolvedValue({
        id: agentId,
        organizationId: orgId,
        primaryWalletId: null,
        name: 'Agent 1',
        description: null,
        provider: null,
        model: null,
        role: AgentRole.FINANCE,
        status: AgentStatus.ACTIVE,
        capabilities: [],
        metadata: {} as Prisma.JsonValue,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      } as Agent);

      repository.findWalletInOrg.mockResolvedValue({
        id: walletId,
        organizationId: orgId,
        agentId: 'other-agent-id',
      } as Wallet);

      await expect(
        service.assignWallet(orgId, actorId, agentId, { walletId }),
      ).rejects.toThrow(ConflictException);
    });
  });
});
