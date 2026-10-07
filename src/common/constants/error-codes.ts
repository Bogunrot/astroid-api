/**
 * Machine-readable error codes returned to API clients. Every domain failure
 * maps to one of these; clients switch on `error.code`, never on the message.
 */
export enum ErrorCode {
  // Generic
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  BAD_REQUEST = 'BAD_REQUEST',
  RATE_LIMITED = 'RATE_LIMITED',
  NOT_IMPLEMENTED = 'NOT_IMPLEMENTED',

  // Auth / authz
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  INVALID_TOKEN = 'INVALID_TOKEN',
  SESSION_REVOKED = 'SESSION_REVOKED',

  // Financial governance
  POLICY_VIOLATION = 'POLICY_VIOLATION',
  BUDGET_EXCEEDED = 'BUDGET_EXCEEDED',
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',
  RISK_TOO_HIGH = 'RISK_TOO_HIGH',
  APPROVAL_REQUIRED = 'APPROVAL_REQUIRED',
  PROPOSAL_EXPIRED = 'PROPOSAL_EXPIRED',
  PROPOSAL_NOT_PENDING = 'PROPOSAL_NOT_PENDING',
  WALLET_FROZEN = 'WALLET_FROZEN',
  AGENT_NOT_ACTIVE = 'AGENT_NOT_ACTIVE',
  EMERGENCY_LOCK = 'EMERGENCY_LOCK',
  VELOCITY_LIMIT_EXCEEDED = 'VELOCITY_LIMIT_EXCEEDED',

  // Stellar
  STELLAR_ERROR = 'STELLAR_ERROR',
  INVALID_STELLAR_ADDRESS = 'INVALID_STELLAR_ADDRESS',
  INVALID_STELLAR_TRANSACTION = 'INVALID_STELLAR_TRANSACTION',

  // Resilience
  CIRCUIT_OPEN = 'CIRCUIT_OPEN',
  LOCK_ACQUISITION_FAILED = 'LOCK_ACQUISITION_FAILED',
}

/** HTTP status codes paired with the domain error codes above. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.VALIDATION_ERROR]: 422,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.BAD_REQUEST]: 400,
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.NOT_IMPLEMENTED]: 501,
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.INVALID_CREDENTIALS]: 401,
  [ErrorCode.TOKEN_EXPIRED]: 401,
  [ErrorCode.INVALID_TOKEN]: 401,
  [ErrorCode.SESSION_REVOKED]: 401,
  [ErrorCode.POLICY_VIOLATION]: 422,
  [ErrorCode.BUDGET_EXCEEDED]: 422,
  [ErrorCode.INSUFFICIENT_FUNDS]: 422,
  [ErrorCode.RISK_TOO_HIGH]: 422,
  [ErrorCode.APPROVAL_REQUIRED]: 202,
  [ErrorCode.PROPOSAL_EXPIRED]: 410,
  [ErrorCode.PROPOSAL_NOT_PENDING]: 409,
  [ErrorCode.WALLET_FROZEN]: 423,
  [ErrorCode.AGENT_NOT_ACTIVE]: 409,
  [ErrorCode.EMERGENCY_LOCK]: 423,
  [ErrorCode.VELOCITY_LIMIT_EXCEEDED]: 422,
  [ErrorCode.STELLAR_ERROR]: 502,
  [ErrorCode.INVALID_STELLAR_ADDRESS]: 400,
  [ErrorCode.INVALID_STELLAR_TRANSACTION]: 400,
  [ErrorCode.CIRCUIT_OPEN]: 503,
  [ErrorCode.LOCK_ACQUISITION_FAILED]: 409,
};

/**
 * Short, human-readable summary of each problem type, used as the `title` of
 * problem details responses (RFC 9457). A title describes the type of problem
 * and must not vary between occurrences; occurrence-specific text belongs in
 * `detail`.
 */
export const ERROR_TITLE: Record<ErrorCode, string> = {
  [ErrorCode.INTERNAL_ERROR]: 'Internal Server Error',
  [ErrorCode.VALIDATION_ERROR]: 'Validation Failed',
  [ErrorCode.NOT_FOUND]: 'Resource Not Found',
  [ErrorCode.CONFLICT]: 'Conflict',
  [ErrorCode.BAD_REQUEST]: 'Bad Request',
  [ErrorCode.RATE_LIMITED]: 'Too Many Requests',
  [ErrorCode.NOT_IMPLEMENTED]: 'Not Implemented',
  [ErrorCode.UNAUTHORIZED]: 'Unauthorized',
  [ErrorCode.FORBIDDEN]: 'Forbidden',
  [ErrorCode.INVALID_CREDENTIALS]: 'Invalid Credentials',
  [ErrorCode.TOKEN_EXPIRED]: 'Token Expired',
  [ErrorCode.INVALID_TOKEN]: 'Invalid Token',
  [ErrorCode.SESSION_REVOKED]: 'Session Revoked',
  [ErrorCode.POLICY_VIOLATION]: 'Policy Violation',
  [ErrorCode.BUDGET_EXCEEDED]: 'Budget Exceeded',
  [ErrorCode.INSUFFICIENT_FUNDS]: 'Insufficient Funds',
  [ErrorCode.RISK_TOO_HIGH]: 'Risk Too High',
  [ErrorCode.APPROVAL_REQUIRED]: 'Approval Required',
  [ErrorCode.PROPOSAL_EXPIRED]: 'Proposal Expired',
  [ErrorCode.PROPOSAL_NOT_PENDING]: 'Proposal Not Pending',
  [ErrorCode.WALLET_FROZEN]: 'Wallet Frozen',
  [ErrorCode.AGENT_NOT_ACTIVE]: 'Agent Not Active',
  [ErrorCode.EMERGENCY_LOCK]: 'Emergency Lock Active',
  [ErrorCode.VELOCITY_LIMIT_EXCEEDED]: 'Velocity Limit Exceeded',
  [ErrorCode.STELLAR_ERROR]: 'Stellar Network Error',
  [ErrorCode.INVALID_STELLAR_ADDRESS]: 'Invalid Stellar Address',
  [ErrorCode.INVALID_STELLAR_TRANSACTION]: 'Invalid Stellar Transaction',
  [ErrorCode.CIRCUIT_OPEN]: 'Service Temporarily Unavailable',
  [ErrorCode.LOCK_ACQUISITION_FAILED]: 'Resource Locked',
};

/** Namespace for the problem type URIs derived from {@link ErrorCode}s. */
export const PROBLEM_TYPE_PREFIX = 'urn:astroid:problem:';

/**
 * Stable problem type URI for an error code, e.g.
 * `VALIDATION_ERROR` -> `urn:astroid:problem:validation-error`. A URN is used
 * because it identifies the type without implying a dereferenceable page.
 */
export function problemTypeFor(code: ErrorCode): string {
  return `${PROBLEM_TYPE_PREFIX}${code.toLowerCase().replace(/_/g, '-')}`;
}
