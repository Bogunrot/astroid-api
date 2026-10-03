-- CreateIndex
-- Agent memory browser: `WHERE "organizationId" = $1 ORDER BY "createdAt" DESC`
-- (MemoryService.list). memory_records grows with every agent decision.
--
-- Built CONCURRENTLY so writes are never blocked. Postgres forbids that inside
-- a transaction, and Prisma runs a multi-statement migration as one, so this
-- file must contain exactly this one statement.
CREATE INDEX CONCURRENTLY "memory_records_organizationId_createdAt_idx" ON "memory_records"("organizationId", "createdAt");
