CREATE INDEX "transactions_organizationId_status_deletedAt_agentId_idx"
ON "transactions"("organizationId", "status", "deletedAt", "agentId");