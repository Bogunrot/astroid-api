# Astroid API Documentation Reference

## Authentication Endpoints (`/auth`)

### POST `/auth/register`
Register a new organization and its owner.

**Request Body:**
| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| organizationName | string | Yes | 2-120 chars | Name of the organization |
| name | string | Yes | 1-120 chars | Full name of the owner |
| email | string | Yes | Valid email | Owner's email address |
| password | string | Yes | 8-200 chars | Secure password |

**Response:** `TokenPairDto`
| Field | Type | Description |
|-------|------|-------------|
| accessToken | string | JWT access token |
| refreshToken | string | JWT refresh token |
| expiresIn | number | Access token lifetime in seconds (default: 900) |
| tokenType | string | Token type (optional) |

### POST `/auth/login`
Authenticate with email and password.

**Request Body:**
| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| email | string | Yes | Valid email | User's email address |
| password | string | Yes | Non-empty | User's password |

**Response:** `TokenPairDto`

### POST `/auth/refresh`
Rotate an access/refresh token pair.

**Request Body:**
| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| refreshToken | string | Yes | Non-empty | Valid refresh token |

**Response:** `TokenPairDto`

### POST `/auth/logout`
Revoke the current session.

**Authentication:** Bearer token required

**Response:** Success message

### GET `/auth/me`
Get the current authenticated user.

**Authentication:** Bearer token required

**Response:** User profile information

### GET `/auth/session`
Get the current session principal (alias for `/auth/me`).

**Authentication:** Bearer token required

**Response:** User profile information

### POST `/auth/passkey/register`
Begin WebAuthn passkey registration.

**Status:** Not implemented - requires `@simplewebauthn/server` package

### POST `/auth/passkey/verify`
Verify a WebAuthn passkey assertion.

**Status:** Not implemented - requires `@simplewebauthn/server` package

---

## Wallet Endpoints (`/wallets`)

### GET `/wallets`
List wallets for the organization.

**Query Parameters:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| offset | number | No | Rows to skip (default: 0); mutually exclusive with `page` |
| page | number | No | Page number, alternative to `offset` (default: 1) |
| limit | number | No | Items per page (default: 50, max: 200) |

**Authentication:** Bearer token required

**Response:** Paginated list of wallets

### POST `/wallets`
Create a wallet (generate a keypair or import an address).

**Authentication:** Requires roles: OWNER, ADMIN, FINANCE, DEVELOPER

**Request Body:**
| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| label | string | No | Max 120 chars | Wallet label/name |
| walletType | enum | No | AGENT, OPERATIONAL, TREASURY | Type of wallet (default: AGENT) |
| network | enum | No | TESTNET, PUBLIC | Stellar network (default: TESTNET) |
| agentId | string | No | Valid UUID | Owning agent ID |
| stellarAddress | string | No | Non-empty | Import existing address (if provided, no keypair is generated) |

**Response:** `WalletSecretDto` (on generation) or wallet object (on import)
| Field | Type | Description |
|-------|------|-------------|
| stellarAddress | string | Public Stellar address (G...) |
| secretKey | string | Generated secret key (S...) - shown ONCE, never stored |

### GET `/wallets/:id`
Get a specific wallet.

**Authentication:** Bearer token required

**Response:** Wallet details

### GET `/wallets/:id/balances`
Fetch live on-chain balances for a wallet.

**Authentication:** Bearer token required

**Response:** Balance information for all assets

### PATCH `/wallets/:id`
Update a wallet label or owning agent.

**Authentication:** Requires roles: OWNER, ADMIN, FINANCE, DEVELOPER

**Request Body:**
| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| label | string | No | Max 120 chars | New wallet label |
| agentId | string | No | Valid UUID or null | Reassign or clear owning agent |

**Response:** Updated wallet object

### POST `/wallets/:id/freeze`
Freeze a wallet (block outgoing transactions).

**Authentication:** Requires roles: OWNER, ADMIN, FINANCE

**Response:** Updated wallet with FROZEN status

### POST `/wallets/:id/unfreeze`
Unfreeze a wallet.

**Authentication:** Requires roles: OWNER, ADMIN, FINANCE

**Response:** Updated wallet with ACTIVE status

### DELETE `/wallets/:id`
Archive (soft-delete) a wallet.

**Authentication:** Requires roles: OWNER, ADMIN

**Response:** Success message

---

## Transaction Endpoints (`/transactions`)

### GET `/transactions`
List transactions for the organization.

**Query Parameters:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| offset | number | No | Rows to skip (default: 0); mutually exclusive with `page` |
| page | number | No | Page number, alternative to `offset` (default: 1) |
| limit | number | No | Items per page (default: 50, max: 200) |

**Authentication:** Bearer token required

**Response:** Paginated list of transactions

### POST `/transactions`
Create a transaction (runs the full governance pipeline).

**Authentication:** Requires roles: OWNER, ADMIN, FINANCE, DEVELOPER

**Request Body:**
| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| walletId | string | Yes | Valid UUID | Sender wallet ID |
| agentId | string | No | Valid UUID | Initiating agent ID |
| budgetId | string | No | Valid UUID | Budget to charge against |
| asset | string | No | 1-24 chars | Asset code (default: XLM) |
| amount | string | Yes | Positive decimal, max 7 decimal places | Transaction amount |
| recipientAddress | string | Yes | Non-empty | Stellar destination address |
| memo | string | No | Max 28 chars | Transaction memo |
| purpose | string | No | Max 280 chars | Transaction purpose |
| metadata | object | No | Arbitrary JSON | Additional metadata |

**Response:** Transaction object with governance evaluation result

### POST `/transactions/simulate`
Dry-run the governance pipeline without moving funds.

**Authentication:** Bearer token required

**Request Body:** Same as POST `/transactions`

**Response:** Simulation result with policy evaluation

### GET `/transactions/:id`
Get a specific transaction.

**Authentication:** Bearer token required

**Response:** Transaction details

### POST `/transactions/:id/cancel`
Cancel a draft or pending transaction.

**Authentication:** Requires roles: OWNER, ADMIN, FINANCE

**Response:** Updated transaction with CANCELLED status

---

## Policy Endpoints (`/policies`)

### GET `/policies`
List policies for the organization.

**Query Parameters:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| offset | number | No | Rows to skip (default: 0); mutually exclusive with `page` |
| page | number | No | Page number, alternative to `offset` (default: 1) |
| limit | number | No | Items per page (default: 50, max: 200) |

**Authentication:** Bearer token required

**Response:** Paginated list of policies

### POST `/policies`
Create a policy.

**Authentication:** Requires roles: OWNER, ADMIN, FINANCE

**Request Body:**
| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| name | string | Yes | 1-120 chars | Policy name |
| description | string | No | Max 500 chars | Policy description |
| type | enum | Yes | SPENDING_LIMIT, ASSET_RESTRICTION, APPROVAL_WORKFLOW, TIME_WINDOW, EMERGENCY_LOCK | Policy type |
| agentId | string | No | Valid UUID | Scope policy to specific agent |
| configuration | object | No | Valid policy configuration | Policy-specific settings (see below) |
| priority | number | No | 0-1000 | Evaluation priority (default: 100) |
| enabled | boolean | No | - | Policy active state (default: true) |

**Configuration Schema:**
| Field | Type | Description |
|-------|------|-------------|
| maxAmount | number | Maximum single transaction amount |
| minAmount | number | Minimum single transaction amount |
| allowedAssets | string[] | List of allowed asset codes |
| blockedAssets | string[] | List of blocked asset codes |
| allowedRecipients | string[] | List of allowed recipient addresses |
| blockedRecipients | string[] | List of blocked recipient addresses |
| dailyLimit | number | Daily spending limit |
| weeklyLimit | number | Weekly spending limit |
| monthlyLimit | number | Monthly spending limit |
| timeWindow | object | Allowed time window (startHour, endHour, days) |
| requiresApproval | boolean | Whether approval is required |
| approvalThreshold | number | Amount threshold for approval |
| emergencyLock | boolean | Emergency lock flag (blocks all spending) |

**Response:** Created policy object

### POST `/policies/simulate`
Simulate a transaction intent against active policies.

**Authentication:** Bearer token required

**Request Body:**
| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| agentId | string | No | Valid UUID | Agent ID |
| walletId | string | No | Valid UUID | Wallet ID |
| asset | string | Yes | Non-empty | Asset code |
| amount | number | Yes | Positive | Transaction amount |
| recipientAddress | string | Yes | Non-empty | Destination address |
| spentToday | number | No | Non-negative | Amount spent today |
| spentThisWeek | number | No | Non-negative | Amount spent this week |
| spentThisMonth | number | No | Non-negative | Amount spent this month |

**Response:** Policy evaluation result

### GET `/policies/:id`
Get a specific policy.

**Authentication:** Bearer token required

**Response:** Policy details

### PATCH `/policies/:id`
Update a policy.

**Authentication:** Requires roles: OWNER, ADMIN, FINANCE

**Request Body:** Partial update of POST `/policies` body

**Response:** Updated policy object

### DELETE `/policies/:id`
Delete (soft-delete) a policy.

**Authentication:** Requires roles: OWNER, ADMIN

**Response:** Success message

---

## Budget Endpoints (`/budgets`)

### GET `/budgets`
List budgets for the organization.

**Query Parameters:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| offset | number | No | Rows to skip (default: 0); mutually exclusive with `page` |
| page | number | No | Page number, alternative to `offset` (default: 1) |
| limit | number | No | Items per page (default: 50, max: 200) |

**Authentication:** Bearer token required

**Response:** Paginated list of budgets

### POST `/budgets`
Create a budget.

**Authentication:** Requires roles: OWNER, ADMIN, FINANCE

**Request Body:**
| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| name | string | Yes | 1-120 chars | Budget name |
| period | enum | Yes | DAILY, WEEKLY, MONTHLY | Budget period |
| limit | number | Yes | Positive | Budget limit amount |
| asset | string | Yes | 1-24 chars | Asset code |
| walletId | string | No | Valid UUID | Associated wallet |
| agentId | string | No | Valid UUID | Associated agent |
| resetDate | date | No | Valid date | Custom reset date |

**Response:** Created budget object

### GET `/budgets/:id`
Get a specific budget.

**Authentication:** Bearer token required

**Response:** Budget details with current usage

### PATCH `/budgets/:id`
Update a budget.

**Authentication:** Requires roles: OWNER, ADMIN, FINANCE

**Request Body:** Partial update of POST `/budgets` body

**Response:** Updated budget object

### DELETE `/budgets/:id`
Delete a budget.

**Authentication:** Requires roles: OWNER, ADMIN

**Response:** Success message

---

## Request Correlation

Every response includes the selected request ID in the `x-request-id` header and the standard response envelope. A caller-supplied ID is accepted only when it is 1-128 ASCII characters, starts with a letter or digit, and otherwise contains only letters, digits, `.`, `_`, `:`, or `-`. Invalid values are replaced with a server-generated UUID. The selected ID is propagated as typed event/job metadata and is isolated per concurrent request.

## Audit History (`/audit`)

### GET `/audit`
List audit records in reverse chronological order using a stable `(createdAt, id)` keyset.

**Query Parameters:** `limit` defaults to 20 and is bounded to 1-100; `cursor` is the opaque `nextCursor` from the previous response; optional `actorId`, `action`, `resourceId`, `from`, and `to` filters apply within the authenticated organization. `from` and `to` are inclusive ISO 8601 timestamps and `from` must not be later than `to`.

The response `meta` includes `limit`, `hasNext`, and `nextCursor` (null on the final page). New records inserted after a page is read do not shift subsequent pages.

**Example:** `GET /audit?limit=20&actorId=user-123&action=wallet.created`

## Outbound Webhook Signatures

Webhook creation and secret rotation responses disclose the signing secret once. Later list, get, update, delivery, and audit responses never include it. Store the secret securely and rotate it when compromised.

Every delivery includes `x-astroid-signature`, `x-astroid-signature-version`, `x-astroid-timestamp`, and `x-astroid-event-id`. `x-astroid-delivery` remains an alias for the event ID. The signature header is `v1=<lowercase hex HMAC-SHA256>` and the version header is `v1`.

The canonical signed bytes are UTF-8 `v1.<timestamp>.<event-id>.` followed by the exact raw HTTP body bytes. Each retry uses the same event ID and body, with a fresh timestamp and signature. Consumers should also reject timestamps outside their chosen replay window.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyAstroidWebhook({ secret, headers, rawBody }) {
  const version = headers['x-astroid-signature-version'];
  const timestamp = headers['x-astroid-timestamp'];
  const eventId = headers['x-astroid-event-id'];
  const received = headers['x-astroid-signature'];
  if (version !== 'v1' || !/^\d{1,12}$/.test(timestamp) || !eventId) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const prefix = Buffer.from(`v1.${timestamp}.${eventId}.`, 'utf8');
  const expected = createHmac('sha256', secret)
    .update(Buffer.concat([prefix, rawBody]))
    .digest();
  const match = /^v1=([0-9a-f]{64})$/.exec(received);
  if (!match) return false;
  const actual = Buffer.from(match[1], 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
```

## Health Probes (`/health`)

The liveness and readiness probes are served **outside** the API prefix, so
orchestrator and load-balancer probe paths do not change with the API version.
Both are public, exempt from rate limiting, excluded from the audit trail, and
return raw JSON (no success envelope).

### GET `/health/live`
Liveness probe. Returns `200` whenever the process is running. It performs no
dependency checks, so a database or cache outage never causes an otherwise
healthy process to be restarted.

**Authentication:** Public

**Response (200):**
```json
{ "status": "up", "timestamp": "2026-09-28T10:00:00.000Z", "uptimeSeconds": 42 }
```

### GET `/health/ready`
Readiness probe. Probes the database (`SELECT 1`) and cache (Redis `PING`) in
parallel, each bounded by a 2 second timeout. Returns `200` when every
dependency is up and `503` when any is down.

**Authentication:** Public

**Response (503 example):**
```json
{
  "status": "down",
  "timestamp": "2026-09-28T10:00:00.000Z",
  "services": {
    "database": {
      "status": "down",
      "latencyMs": 2001,
      "timestamp": "2026-09-28T10:00:00.000Z",
      "error": "Database health check timed out after 2000ms"
    },
    "cache": { "status": "up", "latencyMs": 1, "timestamp": "2026-09-28T10:00:00.000Z" }
  }
}
```

Richer diagnostics (including Stellar and migration status) remain available
under the API prefix at `GET /{API_PREFIX}/health/readiness`,
`GET /{API_PREFIX}/health/liveness` and `GET /{API_PREFIX}/health/database`.

---

## Common Types

### Pagination Query
Every list endpoint accepts the same query parameters.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| offset | number | 0 | Zero-based number of rows to skip. Mutually exclusive with `page` |
| page | number | 1 | 1-based page number, an alternative to `offset` |
| limit | number | 50 | Items per page, capped at 200 |
| sort | string | createdAt | Sort field (restricted to an allow-list per endpoint) |
| order | `asc` \| `desc` | desc | Sort direction |

Negative, non-integer or non-numeric values, a `limit` above 200, or supplying both `offset` and `page` return `400 Bad Request`.

Paginated responses carry the total row count in the `X-Total-Count` header and in `meta`:
```json
{
  "success": true,
  "data": [],
  "meta": { "offset": 50, "page": 2, "limit": 50, "total": 120, "totalPages": 3, "hasNext": true, "hasPrev": true },
  "requestId": "req_..."
}
```

### Error Response
All endpoints return errors as [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem details with `Content-Type: application/problem+json`:
```json
{
  "type": "urn:astroid:problem:validation-error",
  "title": "Validation Failed",
  "status": 400,
  "detail": "Request validation failed",
  "instance": "/api/v1/agents",
  "code": "VALIDATION_ERROR",
  "requestId": "req_018f...",
  "details": [{ "path": "limit", "message": "Number must be less than or equal to 200" }]
}
```

| Member | Description |
|--------|-------------|
| `type` | URI identifying the problem type (`urn:astroid:problem:<code>`), or `about:blank` for plain HTTP errors without a dedicated code (e.g. 405) |
| `title` | Short summary of the problem type; the same for every occurrence |
| `status` | HTTP status code |
| `detail` | Explanation specific to this occurrence |
| `instance` | Request path that produced the error (query string omitted) |
| `code` | Machine-readable error code; clients should switch on this rather than on `title` or `detail` |
| `requestId` | Correlation id, matching the `x-request-id` header |
| `details` | Optional structured context, e.g. field-level validation errors |

Unhandled server errors always return `500` with `code: "INTERNAL_ERROR"` and a generic `detail`; internal information is only written to the server logs under the `requestId`.

### Authentication
Most endpoints require Bearer token authentication in the format:
```
Authorization: Bearer <access_token>
```

Tokens are obtained via `/auth/login` or `/auth/register` endpoints.

### Public Endpoint Rate Limiting
Unauthenticated endpoints (routes marked `@Public()`, such as `/auth/login`, `/auth/register` and `/auth/refresh`, and every route under `/public/`) share a per-IP sliding-window budget: 60 requests per 60 seconds by default, configurable with `PUBLIC_RATE_LIMIT_MAX_REQUESTS` and `PUBLIC_RATE_LIMIT_WINDOW_SECONDS`. Counters are stored in Redis, so the budget applies across all API instances.

Every rate-limited response includes:

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Requests allowed per window |
| `X-RateLimit-Remaining` | Requests left in the current window |
| `X-RateLimit-Reset` | Unix time (seconds) at which the next request slot frees up |

When the budget is exhausted the API responds with `429 Too Many Requests`, a `Retry-After` header (seconds) and error code `RATE_LIMITED`. These limits are in addition to the per-route auth throttling on the `/auth` endpoints.
