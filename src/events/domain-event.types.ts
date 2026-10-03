import { DomainEventNameType } from './event-names';

/**
 * The canonical envelope every emitted domain event is wrapped in. Carries
 * enough context (organization, actor, aggregate, correlation) to persist an
 * immutable ledger entry and to fan out to webhooks.
 */
export interface DomainEventEnvelope<TPayload = Record<string, unknown>> {
  eventId?: string;
  name: DomainEventNameType;
  organizationId?: string;
  aggregateType: string;
  aggregateId?: string;
  actorId?: string;
  requestId?: string;
  correlationId?: string;
  metadata?: DomainEventMetadata;
  payload: TPayload;
  occurredAt: Date;
}

export const DOMAIN_EVENT_ENVELOPE = 'astroid.domain_event';

export interface DomainEventMetadata {
  requestId: string;
  correlationId: string;
  traceId?: string;
}

// Base payload types that extend Record<string, unknown> for flexibility
export interface OrganizationRegisteredPayload extends Record<string, unknown> {
  organizationId: string;
  name?: string;
  ownerUserId?: string;
}

export interface OrganizationUpdatedPayload extends Record<string, unknown> {
  organizationId: string;
}

export interface UserInvitedPayload extends Record<string, unknown> {
  organizationId?: string;
  email?: string;
  userId?: string;
  role?: string;
}

export interface UserUpdatedPayload extends Record<string, unknown> {
  organizationId?: string;
  userId: string;
  status?: string;
}

export interface UserRemovedPayload extends Record<string, unknown> {
  organizationId?: string;
  userId: string;
}

export interface WalletCreatedPayload extends Record<string, unknown> {
  walletId: string;
  stellarAddress?: string;
  walletType?: string;
  agentId?: string;
  imported?: boolean;
}

export interface WalletUpdatedPayload extends Record<string, unknown> {
  walletId: string;
  label?: string;
  status?: string;
}

export interface WalletImportedPayload extends Record<string, unknown> {
  walletId: string;
  stellarAddress?: string;
  walletType?: string;
}

export interface WalletFrozenPayload extends Record<string, unknown> {
  walletId: string;
  reason?: string;
  archived?: boolean;
}

export interface WalletArchivedPayload extends Record<string, unknown> {
  walletId: string;
}

export interface WalletBalanceUpdatedPayload extends Record<string, unknown> {
  walletId: string;
  balance?: string;
  asset?: string;
  stellarAddress?: string;
  balanceCount?: number;
}

export interface AgentRegisteredPayload extends Record<string, unknown> {
  agentId: string;
  name: string;
  role: string;
}

export interface AgentUpdatedPayload extends Record<string, unknown> {
  agentId: string;
  name?: string;
  role?: string;
}

export interface AgentSuspendedPayload extends Record<string, unknown> {
  agentId: string;
  status?: string;
  archived?: boolean;
}

export interface AgentReactivatedPayload extends Record<string, unknown> {
  agentId: string;
  status?: string;
}

export interface AgentWalletAssignedPayload extends Record<string, unknown> {
  agentId: string;
  walletId: string;
}

export interface PolicyCreatedPayload extends Record<string, unknown> {
  policyId: string;
  name?: string;
  type?: string;
  limitAmount?: string;
}

export interface PolicyUpdatedPayload extends Record<string, unknown> {
  policyId: string;
  deleted?: boolean;
}

export interface PolicyDeletedPayload extends Record<string, unknown> {
  policyId: string;
}

export interface PolicyEvaluatedPayload extends Record<string, unknown> {
  transactionId?: string;
  passed: boolean;
  violations: string[];
  requiresApproval: boolean;
}

export interface PolicyViolatedPayload extends Record<string, unknown> {
  violations: Array<{ code: string; message: string }>;
}

export interface PolicyOverrideExpiredPayload extends Record<string, unknown> {
  policyId: string;
}

export interface BudgetCreatedPayload extends Record<string, unknown> {
  budgetId: string;
  name?: string;
  limitAmount?: string;
}

export interface BudgetUpdatedPayload extends Record<string, unknown> {
  budgetId: string;
  deleted?: boolean;
}

export interface BudgetAllocatedPayload extends Record<string, unknown> {
  budgetId: string;
  amount?: string;
  parentBudgetId?: string;
}

export interface BudgetConsumedPayload extends Record<string, unknown> {
  budgetId: string;
  amount?: number | string;
}

export interface BudgetExceededPayload extends Record<string, unknown> {
  budgetId: string;
  attempted?: string;
  remaining?: string;
  limit?: string;
  agentId?: string;
  windowSizeMs?: number;
}

export interface BudgetWarningPayload extends Record<string, unknown> {
  budgetId?: string;
  remaining?: string;
  threshold?: string | number;
  utilisation?: number | string;
  walletId?: string;
}

export interface ProposalCreatedPayload extends Record<string, unknown> {
  proposalId: string;
  transactionId: string;
  requiredApprovals?: number;
}

export interface ProposalApprovedPayload extends Record<string, unknown> {
  proposalId: string;
  transactionId: string;
  approvedBy?: string;
  approvals?: number | string[];
}

export interface ProposalRejectedPayload extends Record<string, unknown> {
  proposalId: string;
  transactionId: string;
  rejectedBy?: string;
}

export interface ProposalExpiredPayload extends Record<string, unknown> {
  proposalId: string;
  transactionId?: string;
}

export interface ProposalExecutedPayload extends Record<string, unknown> {
  proposalId: string;
  transactionId: string;
}

export interface TransactionCreatedPayload extends Record<string, unknown> {
  transactionId: string;
  walletId?: string;
  amount?: string;
  asset?: string;
  riskBand?: string;
}

export interface TransactionSubmittedPayload extends Record<string, unknown> {
  transactionId: string;
  stellarHash?: string;
}

export interface TransactionCompletedPayload extends Record<string, unknown> {
  transactionId: string;
  stellarHash?: string;
  amount?: string;
  asset?: string;
}

export interface TransactionFailedPayload extends Record<string, unknown> {
  transactionId: string;
  stellarHash?: string;
  reason?: string;
}

export interface TransactionCancelledPayload extends Record<string, unknown> {
  transactionId: string;
}

export interface RiskEvaluatedPayload extends Record<string, unknown> {
  transactionId?: string;
  score: number;
  band: string;
  factors?: Record<string, unknown> | Array<unknown>;
  simulationSuccess?: boolean;
}

export interface RiskAlertPayload extends Record<string, unknown> {
  transactionId?: string;
  riskLevel?: string;
}
