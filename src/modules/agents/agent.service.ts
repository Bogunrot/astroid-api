import { Injectable } from '@nestjs/common';
import { Agent, AgentStatus, Prisma } from '@prisma/client';
import { AgentRepository } from './agent.repository';
import { AssignWalletInput, CreateAgentInput, UpdateAgentInput } from './agent.dto';
import { ConflictException, NotFoundException } from '../../common/exceptions/domain.exception';
import {
  buildPaginationMeta,
  PaginationQuery,
  toPrismaPagination,
} from '../../common/helpers/pagination';
import { Paginated } from '../../common/interfaces/api-response.interface';
import { EventBusService } from '../../events/event-bus.service';
import { DomainEventName } from '../../events/event-names';
import { EncryptionService } from '../../common/encryption/encryption.service';

const SORTABLE = ['createdAt', 'name', 'role', 'status'];

/**
 * Manages the lifecycle of autonomous agents: registration, updates, status
 * transitions (pause/reactivate/suspend) and primary-wallet assignment.
 * Automatically encrypts sensitive agent private keys, credentials, and API secrets
 * before database persistence, and decrypts on retrieval.
 */
@Injectable()
export class AgentService {
  constructor(
    private readonly repository: AgentRepository,
    private readonly eventBus: EventBusService,
    private readonly encryptionService: EncryptionService,
  ) {}

  /** Encrypts any sensitive fields inside agent metadata. */
  encryptAgentMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
    return this.encryptionService.transformSensitiveFields(metadata, 'encrypt');
  }

  /** Decrypts encrypted sensitive fields inside agent metadata. */
  decryptAgentMetadata(
    metadata: Record<string, unknown> | Prisma.JsonValue,
  ): Record<string, unknown> {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return {};
    }
    return this.encryptionService.transformSensitiveFields(
      metadata as Record<string, unknown>,
      'decrypt',
    );
  }

  /** Transforms an Agent record by decrypting its sensitive metadata fields. */
  decryptAgent<T extends Agent | null>(agent: T): T {
    if (!agent) {
      return agent;
    }
    return {
      ...agent,
      metadata: this.decryptAgentMetadata(agent.metadata) as Prisma.JsonValue,
    };
  }

  async create(organizationId: string, actorId: string, input: CreateAgentInput) {
    const encryptedMetadata = input.metadata
      ? this.encryptAgentMetadata(input.metadata as Record<string, unknown>)
      : {};

    const agent = await this.repository.create({
      organization: { connect: { id: organizationId } },
      name: input.name,
      description: input.description,
      provider: input.provider,
      model: input.model,
      role: input.role,
      capabilities: input.capabilities,
      metadata: encryptedMetadata as Prisma.InputJsonValue,
    });

    await this.eventBus.emit(
      DomainEventName.AgentRegistered,
      { agentId: agent.id, name: agent.name, role: agent.role },
      { organizationId, actorId, aggregateType: 'agent', aggregateId: agent.id },
    );

    return this.decryptAgent(agent);
  }

  async list(organizationId: string, query: PaginationQuery) {
    const where: Prisma.AgentWhereInput = { organizationId, deletedAt: null };
    if (query.search) {
      where.name = { contains: query.search, mode: 'insensitive' };
    }
    if (query.filter) {
      where.status = query.filter as AgentStatus;
    }
    const pagination = toPrismaPagination(query, SORTABLE);
    const { items, total } = await this.repository.findManyAndCount(where, pagination);
    const decryptedItems = items.map((agent) => this.decryptAgent(agent));
    return new Paginated(decryptedItems, buildPaginationMeta(total, query));
  }

  async getOrThrow(organizationId: string, id: string): Promise<Agent> {
    const agent = await this.repository.findById(organizationId, id);
    if (!agent) {
      throw new NotFoundException('Agent', id);
    }
    return this.decryptAgent(agent);
  }

  async update(organizationId: string, actorId: string, id: string, input: UpdateAgentInput) {
    await this.getOrThrow(organizationId, id);
    const data: Prisma.AgentUpdateInput = {
      name: input.name,
      description: input.description,
      provider: input.provider,
      model: input.model,
      role: input.role,
      capabilities: input.capabilities,
    };
    if (input.metadata) {
      data.metadata = this.encryptAgentMetadata(
        input.metadata as Record<string, unknown>,
      ) as Prisma.InputJsonValue;
    }
    const agent = await this.repository.update(id, data);
    await this.eventBus.emit(
      DomainEventName.AgentUpdated,
      { agentId: id },
      { organizationId, actorId, aggregateType: 'agent', aggregateId: id },
    );
    return this.decryptAgent(agent);
  }

  /** Transitions an agent's status, emitting the matching lifecycle event. */
  async setStatus(organizationId: string, actorId: string, id: string, status: AgentStatus) {
    await this.getOrThrow(organizationId, id);
    const agent = await this.repository.update(id, { status });
    const event =
      status === AgentStatus.ACTIVE
        ? DomainEventName.AgentReactivated
        : DomainEventName.AgentSuspended;
    await this.eventBus.emit(
      event,
      { agentId: id, status },
      { organizationId, actorId, aggregateType: 'agent', aggregateId: id },
    );
    return this.decryptAgent(agent);
  }

  async remove(organizationId: string, actorId: string, id: string) {
    await this.getOrThrow(organizationId, id);
    await this.repository.softDelete(id);
    await this.eventBus.emit(
      DomainEventName.AgentSuspended,
      { agentId: id, archived: true },
      { organizationId, actorId, aggregateType: 'agent', aggregateId: id },
    );
    return { id, archived: true };
  }

  /** Assigns a wallet as the agent's primary wallet (must be in the same org). */
  async assignWallet(
    organizationId: string,
    actorId: string,
    id: string,
    input: AssignWalletInput,
  ) {
    await this.getOrThrow(organizationId, id);
    const wallet = await this.repository.findWalletInOrg(organizationId, input.walletId);
    if (!wallet) {
      throw new NotFoundException('Wallet', input.walletId);
    }
    if (wallet.agentId && wallet.agentId !== id) {
      throw new ConflictException('Wallet is already owned by another agent');
    }
    const agent = await this.repository.update(id, {
      primaryWallet: { connect: { id: input.walletId } },
    });
    await this.eventBus.emit(
      DomainEventName.AgentWalletAssigned,
      { agentId: id, walletId: input.walletId },
      { organizationId, actorId, aggregateType: 'agent', aggregateId: id },
    );
    return this.decryptAgent(agent);
  }
}
