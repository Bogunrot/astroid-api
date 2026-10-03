-- CreateIndex
-- Per-agent memory timeline: `WHERE "agentId" = $1 ORDER BY "createdAt" DESC`
-- (MemoryService.list?filter=<agentId>).
--
-- Built CONCURRENTLY so writes are never blocked. Postgres forbids that inside
-- a transaction, and Prisma runs a multi-statement migration as one, so this
-- file must contain exactly this one statement.
CREATE INDEX CONCURRENTLY "memory_records_agentId_createdAt_idx" ON "memory_records"("agentId", "createdAt");
