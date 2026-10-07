import { Injectable } from '@nestjs/common';
import { Prisma, StellarNetwork, Wallet, WalletStatus } from '@prisma/client';
import { WalletRepository } from './wallet.repository';
import { CreateWalletInput, UpdateWalletInput } from './wallet.dto';
import { StellarService } from '../stellar/stellar.service';
import { StellarNetworkName } from '../../integrations/stellar';
import {
  ConflictException,
  NotFoundException,
} from '../../common/exceptions/domain.exception';
import {
  buildPaginationMeta,
  PaginationQuery,
  toPrismaPagination,
} from '../../common/helpers/pagination';
import { Paginated } from '../../common/interfaces/api-response.interface';
import { EventBusService } from '../../events/event-bus.service';
import { DomainEventName } from '../../events/event-names';

const SORTABLE = ['createdAt', 'label', 'walletType', 'status'];

/** Maps the Prisma network enum to the integration layer's lowercase name. */
export function toNetworkName(network: StellarNetwork): StellarNetworkName {
  switch (network) {
    case StellarNetwork.PUBLIC:
      return 'public';
    case StellarNetwork.FUTURENET:
      return 'futurenet';
    default:
      return 'testnet';
  }
}

export interface WalletCreationResult {
  wallet: Wallet;
  /**
   * Present ONLY when the server generated the keypair. The secret is returned
   * exactly once and is never persisted or logged (non-custodial design).
   */
  secretKey?: string;
}

/**
 * Manages agent/treasury wallets. Astroid is non-custodial: the Wallet model has
 * no secret column. When a keypair is generated server-side, its secret is
 * returned to the caller a single time and immediately discarded.
 */
@Injectable()
export class WalletService {
  constructor(
    private readonly repository: WalletRepository,
    private readonly stellar: StellarService,
    private readonly eventBus: EventBusService,
  ) {}

  async create(
    organizationId: string,
    actorId: string,
    input: CreateWalletInput,
  ): Promise<WalletCreationResult> {
    let stellarAddress: string;
    let secretKey: string | undefined;
    let imported = false;

    if (input.stellarAddress) {
      // Import mode: track an existing address the caller controls.
      this.stellar.assertValidAddress(input.stellarAddress);
      stellarAddress = input.stellarAddress;
      imported = true;
    } else {
      // Generate mode: mint a fresh keypair; return the secret ONCE, never store it.
      const keypair = this.stellar.generateKeypair();
      stellarAddress = keypair.publicKey;
      secretKey = keypair.secretKey;
    }

    const existing = await this.repository.findByAddress(stellarAddress);
    if (existing) {
      throw new ConflictException('A wallet with this Stellar address already exists');
    }

    const wallet = await this.repository.create({
      organization: { connect: { id: organizationId } },
      ...(input.agentId ? { agent: { connect: { id: input.agentId } } } : {}),
      stellarAddress,
      label: input.label,
      walletType: input.walletType,
      network: input.network,
    });

    await this.eventBus.emit(
      imported ? DomainEventName.WalletImported : DomainEventName.WalletCreated,
      { walletId: wallet.id, stellarAddress, walletType: wallet.walletType, imported },
      { organizationId, actorId, aggregateType: 'wallet', aggregateId: wallet.id },
    );

    // secretKey is intentionally NOT persisted and NOT included in the event.
    return { wallet, secretKey };
  }

  async list(organizationId: string, query: PaginationQuery) {
    const where: Prisma.WalletWhereInput = { organizationId, deletedAt: null };
    if (query.search) {
      where.OR = [
        { label: { contains: query.search, mode: 'insensitive' } },
        { stellarAddress: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.filter) {
      where.status = query.filter as WalletStatus;
    }
    const pagination = toPrismaPagination(query, SORTABLE);
    const { items, total } = await this.repository.findManyAndCount(where, pagination);
    return new Paginated(items, buildPaginationMeta(total, query));
  }

  async getOrThrow(organizationId: string, id: string): Promise<Wallet> {
    const wallet = await this.repository.findById(organizationId, id);
    if (!wallet) {
      throw new NotFoundException('Wallet', id);
    }
    return wallet;
  }

  async update(organizationId: string, actorId: string, id: string, input: UpdateWalletInput) {
    await this.getOrThrow(organizationId, id);
    const data: Prisma.WalletUpdateInput = { label: input.label };
    if (input.agentId !== undefined) {
      data.agent = input.agentId ? { connect: { id: input.agentId } } : { disconnect: true };
    }
    const wallet = await this.repository.update(id, data);
    await this.eventBus.emit(
      DomainEventName.WalletUpdated,
      { walletId: id },
      { organizationId, actorId, aggregateType: 'wallet', aggregateId: id },
    );
    return wallet;
  }

  /** Freeze a wallet — blocks all outgoing transactions until unfrozen. */
  async setStatus(
    organizationId: string,
    actorId: string,
    id: string,
    status: WalletStatus,
  ): Promise<Wallet> {
    await this.getOrThrow(organizationId, id);
    const wallet = await this.repository.update(id, { status });
    if (status === WalletStatus.FROZEN) {
      await this.eventBus.emit(
        DomainEventName.WalletFrozen,
        { walletId: id },
        { organizationId, actorId, aggregateType: 'wallet', aggregateId: id },
      );
    } else {
      await this.eventBus.emit(
        DomainEventName.WalletUpdated,
        { walletId: id, status },
        { organizationId, actorId, aggregateType: 'wallet', aggregateId: id },
      );
    }
    return wallet;
  }

  async getBalances(organizationId: string, id: string) {
    const wallet = await this.getOrThrow(organizationId, id);
    const network = toNetworkName(wallet.network);
    const balances = await this.stellar.getBalances(wallet.stellarAddress, network);
    await this.eventBus.emit(
      DomainEventName.WalletBalanceUpdated,
      { walletId: id, balanceCount: balances.length },
      { organizationId, aggregateType: 'wallet', aggregateId: id },
    );
    return { walletId: id, stellarAddress: wallet.stellarAddress, network, balances };
  }

  async remove(organizationId: string, actorId: string, id: string) {
    await this.getOrThrow(organizationId, id);
    await this.repository.softDelete(id);
    await this.eventBus.emit(
      DomainEventName.WalletArchived,
      { walletId: id },
      { organizationId, actorId, aggregateType: 'wallet', aggregateId: id },
    );
    return { id, archived: true };
  }
}
