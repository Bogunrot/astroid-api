import { Injectable } from '@nestjs/common';
import { ApprovalDecision, Prisma, ProposalStatus } from '@prisma/client';
import { ApprovalRepository } from './approval.repository';
import { DecideProposalInput } from './approval.dto';
import { TransactionService } from '../transactions/transaction.service';
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

const SORTABLE = ['createdAt', 'status', 'approvalType'];

/**
 * Human-in-the-loop approval workflow for transactions that the pipeline flagged
 * as requiring sign-off. Collects approvals against a Proposal; once the
 * `requiredApprovals` threshold is met the underlying transaction is executed.
 * A single rejection rejects the whole proposal.
 */
@Injectable()
export class ApprovalService {
  constructor(
    private readonly repository: ApprovalRepository,
    private readonly transactions: TransactionService,
    private readonly eventBus: EventBusService,
  ) {}

  async list(organizationId: string, query: PaginationQuery) {
    const where: Prisma.ProposalWhereInput = { organizationId };
    if (query.filter) {
      where.status = query.filter as ProposalStatus;
    }
    const pagination = toPrismaPagination(query, SORTABLE);
    const { items, total } = await this.repository.findManyAndCount(where, pagination);
    return new Paginated(items, buildPaginationMeta(total, query));
  }

  async getOrThrow(organizationId: string, id: string) {
    const proposal = await this.repository.findById(organizationId, id);
    if (!proposal) {
      throw new NotFoundException('Proposal', id);
    }
    return proposal;
  }

  /** Records a reviewer's decision and advances the proposal state machine. */
  async decide(
    organizationId: string,
    actorId: string,
    proposalId: string,
    input: DecideProposalInput,
  ) {
    const proposal = await this.getOrThrow(organizationId, proposalId);

    if (proposal.status !== ProposalStatus.PENDING) {
      throw new DomainException(
        ErrorCode.PROPOSAL_NOT_PENDING,
        `Proposal is '${proposal.status}' and can no longer be decided`,
      );
    }
    if (proposal.expiresAt && proposal.expiresAt.getTime() < Date.now()) {
      await this.repository.updateProposalStatus(proposalId, { status: ProposalStatus.EXPIRED });
      await this.eventBus.emit(
        DomainEventName.ProposalExpired,
        { proposalId },
        { organizationId, actorId, aggregateType: 'proposal', aggregateId: proposalId },
      );
      throw new DomainException(ErrorCode.PROPOSAL_EXPIRED, 'Proposal has expired');
    }

    const already = await this.repository.findApprovalByUser(proposalId, actorId);
    if (already) {
      throw new ConflictException('You have already voted on this proposal');
    }

    await this.repository.createApproval({
      proposalId,
      userId: actorId,
      decision: input.decision,
      comment: input.comment,
    });

    // A single rejection rejects the whole proposal.
    if (input.decision === ApprovalDecision.REJECTED) {
      await this.repository.updateProposalStatus(proposalId, { status: ProposalStatus.REJECTED });
      await this.transactions.cancel(organizationId, actorId, proposal.transactionId);
      await this.eventBus.emit(
        DomainEventName.ProposalRejected,
        { proposalId, transactionId: proposal.transactionId },
        { organizationId, actorId, aggregateType: 'proposal', aggregateId: proposalId },
      );
      return this.getOrThrow(organizationId, proposalId);
    }

    const approvals = await this.repository.countApprovals(proposalId, 'APPROVED');
    if (approvals < proposal.requiredApprovals) {
      // Threshold not yet reached — remain pending.
      return this.getOrThrow(organizationId, proposalId);
    }

    // Threshold reached: approve, execute the transaction, then mark executed.
    await this.repository.updateProposalStatus(proposalId, { status: ProposalStatus.APPROVED });
    await this.eventBus.emit(
      DomainEventName.ProposalApproved,
      { proposalId, transactionId: proposal.transactionId, approvals },
      { organizationId, actorId, aggregateType: 'proposal', aggregateId: proposalId },
    );

    await this.transactions.execute(organizationId, proposal.transactionId, actorId);
    await this.repository.updateProposalStatus(proposalId, { status: ProposalStatus.EXECUTED });
    await this.eventBus.emit(
      DomainEventName.ProposalExecuted,
      { proposalId, transactionId: proposal.transactionId },
      { organizationId, actorId, aggregateType: 'proposal', aggregateId: proposalId },
    );

    return this.getOrThrow(organizationId, proposalId);
  }
}
