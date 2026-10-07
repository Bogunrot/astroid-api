# Adding Indexes Without Downtime

Indexes on live tables are created with `CREATE INDEX CONCURRENTLY`, so writes to the table are never blocked while the index builds.

## Rules

1. **One statement per migration.** Postgres refuses `CONCURRENTLY` inside a transaction block, and Prisma sends a multi-statement `migration.sql` as a single implicit transaction. Each concurrent index therefore gets its own migration folder whose `migration.sql` contains exactly one `CREATE INDEX CONCURRENTLY` statement. Comments are fine.
2. **Declare the index in `schema.prisma` too.** Add the matching `@@index([...])` so `prisma migrate dev` does not report drift. Use Prisma's default name, `<table>_<col1>_<col2>_idx`, in the SQL.
3. **Do not use `IF NOT EXISTS`.** A failed concurrent build leaves an `INVALID` index behind. `IF NOT EXISTS` would then silently skip it and record the migration as applied, with an index the planner never uses.

## Recovering from a failed build

If `prisma migrate deploy` fails partway through a concurrent build (deadlock, uniqueness violation, cancelled session):

```sql
-- 1. Find and drop the invalid leftover
SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
DROP INDEX CONCURRENTLY IF EXISTS "<index_name>";
```

```bash
# 2. Mark the failed migration as rolled back, then deploy again
npx prisma migrate resolve --rolled-back <migration_folder>
npx prisma migrate deploy
```

## Verifying

Confirm that the planner picks the index for the query it was added for:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM "notifications"
WHERE "organizationId" = $1 AND "userId" = $2
ORDER BY "createdAt" DESC LIMIT 20;
```

The plan should show an `Index Scan` (or `Index Only Scan`) on the new index with no separate `Sort` node.
