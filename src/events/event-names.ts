/**
 * Canonical dot.case domain + webhook event names. Shared across the whole
 * platform and matched exactly by the other Astroid repos and the SDK.
 */
export const DomainEventName = {
  // Organization / user
  OrganizationRegistered: 'organization.registered',
  OrganizationUpdated: 'organization.updated',
  UserInvited: 'user.invited',
  UserUpdated: 'user.updated',
  UserRemoved: 'user.removed',

  // Wallet
  WalletCreated: 'wallet.created',
  WalletUpdated: 'wallet.updated',
  WalletImported: 'wallet.imported',
  WalletFrozen: 'wallet.frozen',
  WalletArchived: 'wallet.archived',
  WalletBalanceUpdated: 'wallet.balance_updated',

  // Agent
  AgentRegistered: 'agent.registered',
  AgentUpdated: 'agent.updated',
  AgentSuspended: 'agent.suspended',
  AgentReactivated: 'agent.reactivated',
  AgentWalletAssigned: 'agent.wallet_assigned',

  // Policy
  PolicyCreated: 'policy.created',
  PolicyUpdated: 'policy.updated',
  PolicyDeleted: 'policy.deleted',
  PolicyEvaluated: 'policy.evaluated',
  PolicyViolated: 'policy.violated',
  PolicyOverrideExpired: 'policy.override_expired',

  // Budget
  BudgetCreated: 'budget.created',
  BudgetUpdated: 'budget.updated',
  BudgetAllocated: 'budget.allocated',
  BudgetConsumed: 'budget.consumed',
  BudgetExceeded: 'budget.exceeded',
  BudgetWarning: 'budget.warning',

  // Proposal / approval
  ProposalCreated: 'proposal.created',
  ProposalApproved: 'proposal.approved',
  ProposalRejected: 'proposal.rejected',
  ProposalExpired: 'proposal.expired',
  ProposalExecuted: 'proposal.executed',

  // Transaction / blockchain
  TransactionCreated: 'transaction.created',
  TransactionSubmitted: 'transaction.submitted',
  TransactionConfirmed: 'transaction.confirmed',
  TransactionCompleted: 'transaction.completed',
  TransactionFailed: 'transaction.failed',
  TransactionCancelled: 'transaction.cancelled',

  // Risk
  RiskEvaluated: 'risk.evaluated',
  RiskAlert: 'risk.alert',
  TransactionRiskScoringRequested: 'transaction.risk_scoring_requested',

  // Notification / audit
  NotificationCreated: 'notification.created',
  AuditRecorded: 'audit.recorded',

  // Dead letter queue / background job lifecycle
  JobFailed: 'dead_letter.job_failed',
  JobRequeued: 'dead_letter.job_requeued',
  JobPurged: 'dead_letter.job_purged',
} as const;

export type DomainEventNameType = (typeof DomainEventName)[keyof typeof DomainEventName];

/** Events that are also delivered to external webhook subscribers. */
export const WEBHOOK_EVENTS: DomainEventNameType[] = [
  DomainEventName.WalletCreated,
  DomainEventName.WalletUpdated,
  DomainEventName.ProposalApproved,
  DomainEventName.ProposalRejected,
  DomainEventName.TransactionCompleted,
  DomainEventName.TransactionFailed,
  DomainEventName.PolicyViolated,
  DomainEventName.BudgetExceeded,
];
