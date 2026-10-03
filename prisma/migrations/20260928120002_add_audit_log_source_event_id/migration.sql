ALTER TABLE "audit_logs" ADD COLUMN "sourceEventId" TEXT;

CREATE UNIQUE INDEX "audit_logs_sourceEventId_key" ON "audit_logs"("sourceEventId");