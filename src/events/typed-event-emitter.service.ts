import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as PayloadTypes from './domain-event.types';
import { DomainEventMetadata } from './domain-event.types';
import { DOMAIN_EVENT_ENVELOPE, DomainEventEnvelope } from './domain-event.types';

/**
 * Type-safe mapping of event names to their payload types.
 * This ensures compile-time type safety when emitting and listening to events.
 */
export interface DomainEventMap {
  // Organization / User
  'organization.registered': PayloadTypes.OrganizationRegisteredPayload;
  'organization.updated': PayloadTypes.OrganizationUpdatedPayload;
  'user.invited': PayloadTypes.UserInvitedPayload;
  'user.updated': PayloadTypes.UserUpdatedPayload;
  'user.removed': PayloadTypes.UserRemovedPayload;

  // Wallet
  'wallet.created': PayloadTypes.WalletCreatedPayload;
  'wallet.updated': PayloadTypes.WalletUpdatedPayload;
  'wallet.imported': PayloadTypes.WalletImportedPayload;
  'wallet.frozen': PayloadTypes.WalletFrozenPayload;
  'wallet.archived': PayloadTypes.WalletArchivedPayload;
  'wallet.balance_updated': PayloadTypes.WalletBalanceUpdatedPayload;

  // Agent
  'agent.registered': PayloadTypes.AgentRegisteredPayload;
  'agent.updated': PayloadTypes.AgentUpdatedPayload;
  'agent.suspended': PayloadTypes.AgentSuspendedPayload;
  'agent.reactivated': PayloadTypes.AgentReactivatedPayload;
  'agent.wallet_assigned': PayloadTypes.AgentWalletAssignedPayload;

  // Policy
  'policy.created': PayloadTypes.PolicyCreatedPayload;
  'policy.updated': PayloadTypes.PolicyUpdatedPayload;
  'policy.deleted': PayloadTypes.PolicyDeletedPayload;
  'policy.evaluated': PayloadTypes.PolicyEvaluatedPayload;
  'policy.violated': PayloadTypes.PolicyViolatedPayload;
  'policy.override_expired': PayloadTypes.PolicyOverrideExpiredPayload;

  // Budget
  'budget.created': PayloadTypes.BudgetCreatedPayload;
  'budget.updated': PayloadTypes.BudgetUpdatedPayload;
  'budget.allocated': PayloadTypes.BudgetAllocatedPayload;
  'budget.consumed': PayloadTypes.BudgetConsumedPayload;
  'budget.exceeded': PayloadTypes.BudgetExceededPayload;
  'budget.warning': PayloadTypes.BudgetWarningPayload;

  // Proposal / Approval
  'proposal.created': PayloadTypes.ProposalCreatedPayload;
  'proposal.approved': PayloadTypes.ProposalApprovedPayload;
  'proposal.rejected': PayloadTypes.ProposalRejectedPayload;
  'proposal.expired': PayloadTypes.ProposalExpiredPayload;
  'proposal.executed': PayloadTypes.ProposalExecutedPayload;

  // Transaction
  'transaction.created': PayloadTypes.TransactionCreatedPayload;
  'transaction.submitted': PayloadTypes.TransactionSubmittedPayload;
  'transaction.completed': PayloadTypes.TransactionCompletedPayload;
  'transaction.failed': PayloadTypes.TransactionFailedPayload;
  'transaction.cancelled': PayloadTypes.TransactionCancelledPayload;

  // Risk
  'risk.evaluated': PayloadTypes.RiskEvaluatedPayload;
  'risk.alert': PayloadTypes.RiskAlertPayload;
}

/**
 * A strongly-typed wrapper around EventEmitter2 for domain events.
 * Enforces compile-time type safety for event payloads and provides
 * type-safe emit/listen methods.
 */
@Injectable()
export class TypedEventEmitter {
  constructor(private readonly emitter: EventEmitter2) {}

  /**
   * Emit a typed domain event.
   * @param event - The event name
   * @param payload - The event payload (type-checked at compile time)
   * @returns boolean indicating if the event had listeners
   */
  emit<K extends keyof DomainEventMap>(
    event: K,
    payload: DomainEventMap[K],
    metadata?: DomainEventMetadata,
  ): boolean {
    return metadata
      ? this.emitter.emit(event as string, payload, metadata)
      : this.emitter.emit(event as string, payload);
  }

  emitEnvelope(envelope: DomainEventEnvelope): boolean {
    return this.emitter.emit(DOMAIN_EVENT_ENVELOPE, envelope);
  }

  /**
   * Listen to a typed domain event.
   * @param event - The event name
   * @param handler - The event handler (type-checked at compile time)
   */
  on<K extends keyof DomainEventMap>(
    event: K,
    handler: (payload: DomainEventMap[K], metadata?: DomainEventMetadata) => void | Promise<void>,
  ): this {
    this.emitter.on(event as string, handler);
    return this;
  }

  /**
   * Listen to a typed domain event once.
   * @param event - The event name
   * @param handler - The event handler (type-checked at compile time)
   */
  once<K extends keyof DomainEventMap>(
    event: K,
    handler: (payload: DomainEventMap[K], metadata?: DomainEventMetadata) => void | Promise<void>,
  ): this {
    this.emitter.once(event as string, handler);
    return this;
  }

  /**
   * Remove a listener for a typed domain event.
   * @param event - The event name
   * @param handler - The event handler to remove
   */
  off<K extends keyof DomainEventMap>(
    event: K,
    handler: (payload: DomainEventMap[K]) => void | Promise<void>,
  ): this {
    this.emitter.off(event as string, handler);
    return this;
  }

  /**
   * Remove all listeners for a typed domain event.
   * @param event - The event name
   */
  removeAllListeners<K extends keyof DomainEventMap>(event?: K): this {
    this.emitter.removeAllListeners(event as string);
    return this;
  }
}
