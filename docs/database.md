# Database Guidelines & Migration Verification

All database changes must be managed via Prisma migrations.

## Startup Checks

The API retries PostgreSQL connections during startup using exponential backoff. Configure the total number of attempts with `DATABASE_CONNECT_RETRY_ATTEMPTS` (default `5`) and the initial delay with `DATABASE_CONNECT_RETRY_DELAY_MS` (default `1000` ms). Startup fails if either Prisma pool cannot connect or if any checked-in migration is pending or failed; deploy migrations before starting the API.

## Migration Verification Requirements

- Every migration folder must contain a valid, non-empty `migration.sql` file.
- Migration directories must start with a 14-digit timestamp prefix (`YYYYMMDDHHMMSS`) to ensure strict ordering and avoid conflicts.
- Run `npm run db:verify` locally to execute `scripts/verify-migrations.sh` prior to opening a pull request.
- The CI pipeline automatically runs `scripts/verify-migrations.sh` to validate schema syntax, migration structure, and working tree cleanliness.

## Migration CLI and Rollback Protection

`npm run db:migrate -- <command>` wraps the Prisma migration commands behind a production safety guard (`src/database/migration-guard.ts`).

| Command | Effect | Destructive |
| --- | --- | --- |
| `deploy` | Applies pending migrations (`prisma migrate deploy`). | No |
| `status` | Reports applied and pending migrations. | No |
| `down <migration>` | Executes the migration's `down.sql`, then removes it from `_prisma_migrations` in the same script so `deploy` can re-apply it later. | Yes |
| `reset` | Drops and recreates the database (`prisma migrate reset`). | Yes |

Destructive commands are **rejected when `NODE_ENV=production`**: the CLI prints a warning to stderr, exits with code `1`, and never contacts the database. To proceed intentionally, take a verified backup and re-run with `--force`; the override itself is also announced on stderr.

```bash
# Blocked in production
NODE_ENV=production npm run db:migrate -- down 20260901080000_add_cleanup_job_logs

# Explicit override
NODE_ENV=production npm run db:migrate -- down 20260901080000_add_cleanup_job_logs --force
```

Prisma does not generate down migrations. To make a migration reversible, add a hand-written `down.sql` next to its `migration.sql`. One way to draft it is to run the following after editing `schema.prisma` but **before** applying the new migration, so the diff goes from the new datamodel back to the current database state:

```bash
npx prisma migrate diff   --from-schema-datamodel prisma/schema.prisma   --to-schema-datasource prisma/schema.prisma   --script > prisma/migrations/<migration>/down.sql
```

Review the generated SQL by hand before relying on it. `down` refuses to run for a migration without a `down.sql`.
