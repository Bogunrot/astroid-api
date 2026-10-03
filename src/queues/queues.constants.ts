/**
 * Named BullMQ queues. Heavy or asynchronous work is enqueued by the domain
 * modules; workers in `@workers/*` consume them with retry and backoff.
 */
export const Queues = {
  /** Outbound notification deliveries (email, webhook, slack, discord). */
  Notifications: 'notifications',
  /** Webhook retry attempts with exponential backoff. */
  Webhooks: 'webhooks',
  /** Periodic Stellar balance + state synchronization. */
  StellarSync: 'stellar-sync',
  /** Analytics roll-ups and precomputed aggregates. */
  Analytics: 'analytics',
  /** Long-running exports and scheduled reports. */
  Reports: 'reports',
  /** Transactional outbox fan-out jobs. */
  OutboxEvents: 'outbox-events',
  /** Stellar fee-bump submission retries. */
  StellarFeeBump: 'stellar-fee-bump',
  /** Transaction execution pipeline. */
  Transactions: 'transactions',
  /** Asynchronous risk evaluation and scoring. */
  RiskAnalysis: 'risk-analysis',
  /** Dead-letter queue for terminal job failures across all workers. */
  DeadLetter: 'dead-letter',
  /** Audit logs cleanup job. */
  AuditCleanup: 'audit-cleanup',
  /** Asynchronous audit log persistence (batched writes to the audit trail). */
  Audit: 'audit',
} as const;

export type QueueName = (typeof Queues)[keyof typeof Queues];

export interface QueueJobMetadata {
  requestId?: string;
  correlationId?: string;
  traceId?: string;
}

/** Standard payload stored when a job is dead-lettered. */
export interface DlqJobData {
  /** Original queue the job originated from. */
  originalQueue: string;
  /** Original BullMQ job ID. */
  originalJobId?: string;
  /** Original job name. */
  originalJobName?: string;
  /** Payload of the original failed job. */
  payload: unknown;
  /** Terminal failure reason or error message. */
  failedReason?: string;
  /** Stack trace if available. */
  stacktrace?: string[];
  /** Total retry attempts made before dead-lettering. */
  attemptsMade: number;
  /** ISO timestamp when job was dead-lettered. */
  failedAt: string;
  /** Additional metadata (organizationId, transactionId, etc.). */
  metadata?: Record<string, unknown>;
}

/** A single audit log entry queued for asynchronous persistence. */
export interface AuditLogJobEntry {
  organizationId: string;
  userId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  ipAddress?: string | null;
  device?: string | null;
  requestId?: string | null;
}

/** Standard BullMQ job payload for the audit persistence queue. */
export interface AuditJobData {
  /** Batch of audit entries to persist in one transaction. */
  entries: AuditLogJobEntry[];
}

