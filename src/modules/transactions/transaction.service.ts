import { Injectable, Logger } from '@nestjs/common';
import {
  Agent,
  AgentStatus,
  Prisma,
  RiskBand,
  Transaction,
  TransactionStatus,
  Wallet,
  WalletStatus,
} from '@prisma/client';
import { TransactionRepository } from './transaction.repository';
import { SpendingLimitService } from './spending-limit.service';
import { CreateTransactionInput } from './transaction.dto';
import { TransactionsValidator } from './transactions.validator';
import { WalletService, toNetworkName } from '../wallets/wallet.service';
import { PolicyService } from '../policies/policy.service';
import { RiskService } from '../risk/risk.service';
import { BudgetService } from '../budgets/budget.service';
import { StellarService } from '../stellar/stellar.service';
import { AgentService } from '../agents/agent.service';
import { TransactionIntent } from '../policies/policy.types';
import { RiskFactorsInput } from '../risk/risk.types';
import { DomainException } from '../../common/exceptions/domain.exception';
import { ErrorCode } from '../../common/constants/error-codes';
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
import { PrismaService } from '../../database/prisma.service';

const SORTABLE = ['createdAt', 'amount', 'status', 'riskScore'];
const Decimal = Prisma.Decimal;

/**
 * The heart of Astroid: the transaction pipeline. Every agent-initiated payment
 * flows through a deterministic sequence of governance checks before any funds
 * move:
 *   1. resolve + validate the sender wallet (must be ACTIVE / not frozen)
 *   2. resolve + validate the initiating agent (must be ACTIVE)
 *   3. evaluate all applicable policies (may block or require approval)
 *   4. score risk (CRITICAL can never auto-execute)
 *   5. check the budget headroom (does not mutate yet)
 *   6. persist the Transaction row
 *   7. if approval is required -> create a Proposal (status PENDING) and stop
 *      else -> execute on-chain immediately
 * Execution is idempotent-ish and also callable by the approvals module once a
 * proposal is approved.
 */
@Injectable()
export class TransactionService {
  private readonly logger = new Logger(TransactionService.name);

  constructor(
    private readonly repository: TransactionRepository,
    private readonly wallets: WalletService,
    private readonly agents: AgentService,
    private readonly policies: PolicyService,
    private readonly risk: RiskService,
    private readonly budgets: BudgetService,
    private readonly stellar: StellarService,
    private readonly eventBus: EventBusService,
    private readonly prisma: PrismaService,
    private readonly spendingLimits: SpendingLimitService,
  ) {}

  async create(organizationId: string, actorId: string, input: CreateTransactionInput) {
    const amount = Number(input.amount);
    const memoValue = input.memoType && input.memoValue ? input.memoValue : input.memo;
    const { wallet } = await this.preflight(organizationId, input);

    // 2.5. Velocity limit check for agent spending
    if (input.agentId) {
      await this.policies.checkVelocityLimit(organizationId, input.agentId, amount, input.asset, actorId);
    }

    // 2.6. Spending limit evaluation — atomically fetches daily/weekly/monthly
    //      aggregates and evaluates periodic budget caps. On violation, writes
    //      an audit log entry and throws PolicyViolationException (HTTP 422).
    //      Returns the aggregates so we can reuse them in step 3 below.
    const baseIntent = this.toIntent(organizationId, input, amount);
    let enrichedIntent = baseIntent;
    if (input.agentId) {
      const aggregates = await this.spendingLimits.aggregateSpend(input.agentId, input.asset);
      enrichedIntent = {
        ...baseIntent,
        spentToday: aggregates.spentToday,
        spentThisWeek: aggregates.spentThisWeek,
        spentThisMonth: aggregates.spentThisMonth,
      };
      // evaluateSpendingLimits uses the enriched intent so periodic limit
      // checks run against real aggregates — it is a no-op when no periodic
      // limit policy is configured, so the overhead is minimal.
      await this.spendingLimits.evaluateSpendingLimits(enrichedIntent, actorId);
    }

    // 3. Full policy evaluation — evaluates all rule types (maxAmount, assets,
    //    recipients, time windows, emergency lock, periodic limits) with real
    //    spend aggregates already embedded in the intent.
    const policyResult = await this.policies.evaluateIntent(enrichedIntent, actorId);
    if (!policyResult.passed) {
      throw new DomainException(
        ErrorCode.POLICY_VIOLATION,
        'Transaction blocked by one or more policies',
        policyResult.violations,
      );
    }

    // 4. Risk scoring — CRITICAL can never auto-execute.
    const assessment = await this.risk.evaluate(
      organizationId,
      await this.toRiskFactors(organizationId, wallet, input, amount, policyResult.violations.length),
      { actorId },
    );

    // 5. Budget headroom (no mutation yet).
    if (input.budgetId) {
      await this.budgets.assertWithinBudget(organizationId, input.budgetId, amount);
    }

    const requiresApproval = policyResult.requiresApproval || !assessment.canAutoExecute;

    // 6. Persist the transaction row.
    const transaction = await this.repository.create({
      organization: { connect: { id: organizationId } },
      wallet: { connect: { id: wallet.id } },
      ...(input.agentId ? { agent: { connect: { id: input.agentId } } } : {}),
      ...(policyResult.matchedPolicyId
        ? { policy: { connect: { id: policyResult.matchedPolicyId } } }
        : {}),
      ...(input.budgetId ? { budget: { connect: { id: input.budgetId } } } : {}),
      asset: input.asset,
      amount: new Decimal(input.amount),
      senderAddress: wallet.stellarAddress,
      recipientAddress: input.recipientAddress,
      memo: memoValue,
      purpose: input.purpose,
      status: TransactionStatus.DRAFT,
      riskScore: assessment.score,
      riskBand: assessment.band,
      requiresApproval,
      metadata: input.metadata as Prisma.InputJsonValue,
    });
    await this.eventBus.emit(
      DomainEventName.TransactionCreated,
      { transactionId: transaction.id, amount: input.amount, riskBand: assessment.band },
      { organizationId, actorId, aggregateType: 'transaction', aggregateId: transaction.id },
    );

    // 7. Branch: approval proposal, or immediate execution.
    if (requiresApproval) {
      const proposal = await this.createProposal(organizationId, transaction, assessment.band);
      await this.repository.update(transaction.id, { status: TransactionStatus.PENDING });
      return {
        transaction: { ...transaction, status: TransactionStatus.PENDING },
        proposal,
        requiresApproval: true,
        risk: assessment,
      };
    }

    const executed = await this.execute(organizationId, transaction.id, actorId);
    return { transaction: executed, requiresApproval: false, risk: assessment };
  }

  /**
   * Submits a transaction on-chain and settles its budget. Called directly for
   * auto-executable transactions and by the approvals module once a proposal has
   * gathered the required approvals.
   */
  async execute(organizationId: string, transactionId: string, actorId?: string): Promise<Transaction> {
    const tx = await this.getOrThrow(organizationId, transactionId);
    if (
      tx.status === TransactionStatus.COMPLETED ||
      tx.status === TransactionStatus.SUBMITTED ||
      tx.status === TransactionStatus.CONFIRMED
    ) {
      throw new ConflictException(`Transaction '${transactionId}' has already been executed`);
    }
    const wallet = await this.wallets.getOrThrow(organizationId, tx.walletId);
    this.assertWalletSpendable(wallet);

    await this.repository.update(tx.id, { status: TransactionStatus.SUBMITTED });
    await this.eventBus.emit(
      DomainEventName.TransactionSubmitted,
      { transactionId: tx.id },
      { organizationId, actorId, aggregateType: 'transaction', aggregateId: tx.id },
    );

    try {
      const result = await this.stellar.submitPayment({
        sourceAddress: wallet.stellarAddress,
        destinationAddress: tx.recipientAddress,
        asset: tx.asset,
        amount: tx.amount.toFixed(7),
        memo: tx.memo ?? undefined,
        network: toNetworkName(wallet.network),
      });

      const completed = await this.repository.update(tx.id, {
        status: result.successful ? TransactionStatus.COMPLETED : TransactionStatus.FAILED,
        stellarHash: result.hash,
        confirmationCount: result.ledger ? 1 : 0,
      });

      if (result.successful && tx.budgetId) {
        await this.budgets.consume(organizationId, tx.budgetId, Number(tx.amount));
      }

      await this.eventBus.emit(
        result.successful
          ? DomainEventName.TransactionCompleted
          : DomainEventName.TransactionFailed,
        { transactionId: tx.id, stellarHash: result.hash },
        { organizationId, actorId, aggregateType: 'transaction', aggregateId: tx.id },
      );
      return completed;
    } catch (error) {
      this.logger.warn(
        `Transaction ${tx.id} failed to submit: ${(error as Error).message}`,
      );
      await this.repository.update(tx.id, { status: TransactionStatus.FAILED });
      await this.eventBus.emit(
        DomainEventName.TransactionFailed,
        { transactionId: tx.id, reason: (error as Error).message },
        { organizationId, actorId, aggregateType: 'transaction', aggregateId: tx.id },
      );
      throw error;
    }
  }

  /** Dry-run: runs every governance check without persisting or moving funds. */
  async simulate(organizationId: string, input: CreateTransactionInput) {
    const amount = Number(input.amount);
    const { wallet } = await this.preflight(organizationId, input);
    const intent = this.toIntent(organizationId, input, amount);
    const policyResult = await this.policies.evaluateIntent(intent);
    const assessment = this.risk.assess(
      await this.toRiskFactors(organizationId, wallet, input, amount, policyResult.violations.length),
    );
    const requiresApproval = policyResult.requiresApproval || !assessment.canAutoExecute;
    return {
      wouldPass: policyResult.passed,
      requiresApproval,
      policy: {
        passed: policyResult.passed,
        violations: policyResult.violations,
      },
      risk: assessment,
    };
  }

  async list(organizationId: string, query: PaginationQuery) {
    const where: Prisma.TransactionWhereInput = { organizationId, deletedAt: null };
    if (query.search) {
      where.OR = [
        { recipientAddress: { contains: query.search, mode: 'insensitive' } },
        { purpose: { contains: query.search, mode: 'insensitive' } },
        { stellarHash: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.filter) {
      where.status = query.filter as TransactionStatus;
    }
    const pagination = toPrismaPagination(query, SORTABLE);
    const { items, total } = await this.repository.findManyAndCount(where, pagination);
    return new Paginated(items, buildPaginationMeta(total, query));
  }

  async getOrThrow(organizationId: string, id: string): Promise<Transaction> {
    const tx = await this.repository.findById(organizationId, id);
    if (!tx) {
      throw new NotFoundException('Transaction', id);
    }
    return tx;
  }

  async cancel(organizationId: string, actorId: string, id: string) {
    const tx = await this.getOrThrow(organizationId, id);
    if (
      tx.status !== TransactionStatus.DRAFT &&
      tx.status !== TransactionStatus.PENDING
    ) {
      throw new ConflictException('Only draft or pending transactions can be cancelled');
    }
    const cancelled = await this.repository.update(id, { status: TransactionStatus.CANCELLED });
    await this.eventBus.emit(
      DomainEventName.TransactionCancelled,
      { transactionId: id },
      { organizationId, actorId, aggregateType: 'transaction', aggregateId: id },
    );
    return cancelled;
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** Resolves and validates the sender wallet + agent before any evaluation. */
  private async preflight(
    organizationId: string,
    input: CreateTransactionInput,
  ): Promise<{ wallet: Wallet; agent?: Agent }> {
    const wallet = await this.wallets.getOrThrow(organizationId, input.walletId);
    this.assertWalletSpendable(wallet);

    const memoValue = input.memoType && input.memoValue ? input.memoValue : input.memo;
    TransactionsValidator.validateTransactionInput(input.recipientAddress, memoValue);

    let agent: Agent | undefined;
    if (input.agentId) {
      agent = await this.agents.getOrThrow(organizationId, input.agentId);
      if (agent.status !== AgentStatus.ACTIVE) {
        throw new DomainException(
          ErrorCode.AGENT_NOT_ACTIVE,
          `Agent '${agent.id}' is not active (status: ${agent.status})`,
        );
      }
    }
    return { wallet, agent };
  }

  private assertWalletSpendable(wallet: Wallet): void {
    if (wallet.status === WalletStatus.FROZEN) {
      throw new DomainException(ErrorCode.WALLET_FROZEN, 'Wallet is frozen');
    }
    if (wallet.status !== WalletStatus.ACTIVE) {
      throw new DomainException(
        ErrorCode.WALLET_FROZEN,
        `Wallet is not active (status: ${wallet.status})`,
      );
    }
  }

  private toIntent(
    organizationId: string,
    input: CreateTransactionInput,
    amount: number,
  ): TransactionIntent {
    return {
      organizationId,
      agentId: input.agentId,
      walletId: input.walletId,
      asset: input.asset,
      amount,
      recipientAddress: input.recipientAddress,
      at: new Date(),
    };
  }

  private async toRiskFactors(
    organizationId: string,
    wallet: Wallet,
    input: CreateTransactionInput,
    amount: number,
    policyViolations: number,
  ): Promise<RiskFactorsInput> {
    const [knownRecipient, recentTransactionCount] = await Promise.all([
      this.repository.hasPaidRecipient(organizationId, input.recipientAddress),
      this.repository.recentCountForWallet(wallet.id),
    ]);
    const walletAgeDays = Math.floor(
      (Date.now() - wallet.createdAt.getTime()) / 86_400_000,
    );
    return {
      amount,
      asset: input.asset,
      knownRecipient,
      recentTransactionCount,
      walletAgeDays,
      policyViolations,
      hourUtc: new Date().getUTCHours(),
    };
  }

  /** Creates the approval Proposal row directly (avoids a circular module dep). */
  private async createProposal(organizationId: string, tx: Transaction, band: RiskBand) {
    const dualApproval = band === RiskBand.HIGH || band === RiskBand.CRITICAL;
    const proposal = await this.prisma.proposal.create({
      data: {
        organizationId,
        transactionId: tx.id,
        title: `Approval required for ${tx.amount.toFixed(7)} ${tx.asset}`,
        description: tx.purpose ?? undefined,
        approvalType: dualApproval ? 'DUAL' : 'SINGLE',
        requiredApprovals: dualApproval ? 2 : 1,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 72 * 3_600_000),
      },
    });
    await this.eventBus.emit(
      DomainEventName.ProposalCreated,
      { proposalId: proposal.id, transactionId: tx.id, requiredApprovals: proposal.requiredApprovals },
      { organizationId, aggregateType: 'proposal', aggregateId: proposal.id },
    );
    return proposal;
  }
}
