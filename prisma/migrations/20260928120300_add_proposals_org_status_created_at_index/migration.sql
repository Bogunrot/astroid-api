-- CreateIndex
-- Pending-approval count on the dashboard and the status-filtered queue:
-- `WHERE "organizationId" = $1 AND "status" = $2 [ORDER BY "createdAt" DESC]`
-- (AnalyticsRepository.countPendingProposals, ApprovalService.list?filter=).
--
-- Built CONCURRENTLY so writes are never blocked. Postgres forbids that inside
-- a transaction, and Prisma runs a multi-statement migration as one, so this
-- file must contain exactly this one statement.
CREATE INDEX CONCURRENTLY "proposals_organizationId_status_createdAt_idx" ON "proposals"("organizationId", "status", "createdAt");
