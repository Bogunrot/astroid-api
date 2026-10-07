-- CreateIndex
-- Approval queue listing: `WHERE "organizationId" = $1 ORDER BY "createdAt" DESC`
-- (ApprovalService.list without a status filter).
--
-- Built CONCURRENTLY so writes are never blocked. Postgres forbids that inside
-- a transaction, and Prisma runs a multi-statement migration as one, so this
-- file must contain exactly this one statement.
CREATE INDEX CONCURRENTLY "proposals_organizationId_createdAt_idx" ON "proposals"("organizationId", "createdAt");
