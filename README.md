# astroid-api

[![CI](https://github.com/ASTROIDX556/astroid-api/actions/workflows/ci.yml/badge.svg)](https://github.com/ASTROIDX556/astroid-api/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Stellar](https://img.shields.io/badge/Built%20on-Stellar-7C3AED)](https://stellar.org)
[![Drips Wave](https://img.shields.io/badge/Drips-Stellar%20Wave-blue)](https://www.drips.network/wave/stellar)

> NestJS backend — the **intelligence layer** of Astroid, the Financial Operating System for autonomous AI agents on Stellar. Built for the [Drips Stellar Wave Program](https://www.drips.network/wave/stellar).

`astroid-api` is the modular monolith that sits between AI agents and the Stellar blockchain. It owns identity, wallets, spending policies, budgets, approval workflows, risk scoring, transaction intelligence, audit history, and the developer surface (API keys, webhooks). Humans define governance here; agents operate strictly within it.

## Highlights

- **Modular monolith** — 16 domain modules under `src/modules`, each self-contained (controller / service / repository / DTOs) and wired through a shared event bus.
- **Typed everywhere** — Zod-validated input, a uniform response envelope `{ success, data, meta, requestId }`, and typed domain events.
- **Async by design** — BullMQ workers (Redis) for transaction execution, risk analysis, webhook delivery, and notifications.
- **Security first** — JWT access/refresh, passkey (WebAuthn) support, Argon2 hashing, role guards, and per-tier rate limiting.
- **Stellar integration** — pluggable client with a fully-featured mock (`STELLAR_USE_MOCK=true`) so the whole API runs with zero on-chain dependencies in development.
- **AI-powered** — Nvidia NIM integration (`meta/llama-3.1-70b-instruct`) for financial briefings, anomaly detection, and assistant capabilities.


## Architecture

```
astroid-web  ──►  astroid-api  ──►  PostgreSQL (Supabase)
                      │         ──►  Redis / BullMQ (Upstash)
                      │         ──►  Stellar Horizon + Soroban RPC
                      └─────────►  Nvidia NIM AI
```

## Modules

`agents` · `analytics` · `approvals` · `audit` · `auth` · `budgets` · `developer` (API keys) · `memory` · `notifications` · `organizations` · `policies` · `risk` · `stellar` · `transactions` · `wallets` · `webhooks`

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | NestJS 10 |
| Database | PostgreSQL via Prisma 5 (Supabase) |
| Queue | Redis + BullMQ (Upstash) |
| Auth | Passport/JWT + WebAuthn passkeys + Argon2 |
| Blockchain | `@stellar/stellar-sdk` (Horizon + Soroban) |
| AI | Nvidia NIM (`meta/llama-3.1-70b-instruct`) |
| Validation | Zod |
| Logging | Pino |
| API Docs | Swagger |
| Testing | Vitest |

## Quick Start

```bash
npm install
cp .env.example .env            # then edit secrets (JWT_*, DATABASE_URL, …)

npm run prisma:generate         # generate the Prisma client
npm run prisma:migrate          # apply migrations to your database

npm run start:dev               # http://localhost:3000
```

- REST API: `http://localhost:3000/api/v1`
- Swagger docs: `http://localhost:3000/docs`

> **No infra handy?** Set `STELLAR_USE_MOCK=true` (the default) to run without a live Stellar node. PostgreSQL and Redis are still required — see `.env.example` for every variable.

## API Endpoints

| Module | Endpoint prefix | Description |
|---|---|---|
| Auth | `/api/v1/auth` | JWT login, refresh, passkey register/authenticate |
| Organizations | `/api/v1/organizations` | Org CRUD, member management |
| Agents | `/api/v1/agents` | AI agent lifecycle |
| Wallets | `/api/v1/wallets` | Stellar wallet management |
| Transactions | `/api/v1/transactions` | Payment building, submission, history |
| Policies | `/api/v1/policies` | Spending rule CRUD and simulation |
| Budgets | `/api/v1/budgets` | Budget tracking and limits |
| Approvals | `/api/v1/proposals` | Multi-party approval workflows |
| AI | `/api/v1/ai` | Briefings, assistant, anomaly detection |
| Analytics | `/api/v1/analytics` | Dashboard metrics |
| Developer | `/api/v1/developer` | API keys and webhooks |

Full OpenAPI spec available at `/docs` when the server is running.

## Scripts

| Script | Purpose |
|---|---|
| `npm run start:dev` | Watch-mode dev server |
| `npm run build` | Compile to `dist/` |
| `npm run start:prod` | Run the compiled server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | Vitest unit tests |
| `npm run prisma:migrate` | Create/apply a dev migration |
| `npm run prisma:deploy` | Apply migrations in production |

## Data Model

17 Prisma models: `Organization`, `User`, `Agent`, `Wallet`, `Policy`, `Budget`, `Transaction`, `Proposal`, `Approval`, `AuditLog`, `Notification`, `ApiKey`, `Webhook`, `Session`, `MemoryRecord`, `PasskeyCredential`, `DomainEvent`. Schema in [`prisma/`](prisma).

## Environment Variables

All variables are validated against a single schema when the process starts;
if any are missing or malformed, the API exits immediately with a message listing
every problem. See [`docs/configuration.md`](docs/configuration.md) for the full
reference (types, defaults and production rules) and
[`.env.example`](.env.example) for a working local setup. Required variables:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_ACCESS_SECRET` | Access-token signing secret (≥16 chars) |
| `JWT_REFRESH_SECRET` | Refresh-token signing secret (≥16 chars, distinct from the access secret in production) |
| `AI_PROVIDER_KEY` | Nvidia NIM API key (`nvapi-…`) |
| `ENCRYPTION_KEY` | 32-byte encryption key (required in production; a development default is used otherwise) |

## Related Repositories

| Repo | Description |
|---|---|
| [astroid-web](https://github.com/ASTROIDX556/astroid-web) | Next.js dashboard and landing page |
| [astroid-contract](https://github.com/ASTROIDX556/astroid-contract) | Soroban smart contracts (Rust) |
| [astroid-sdk](https://github.com/ASTROIDX556/astroid-sdk) | TypeScript SDK and React hooks |

## Maintainers

| Name | GitHub | Contact |
|---|---|---|
| joshua chekube | [@ASTROIDX556](https://github.com/ASTROIDX556) | Open an issue or discussion |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). All PRs require passing CI and one maintainer approval.

## Security

See [SECURITY.md](SECURITY.md) for the responsible disclosure policy.

## License

MIT — see [LICENSE](LICENSE).
