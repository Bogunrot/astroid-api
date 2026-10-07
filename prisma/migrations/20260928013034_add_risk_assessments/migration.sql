-- CreateRiskAssessment
CREATE TABLE "risk_assessments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "band" "RiskBand" NOT NULL,
    "factors" JSONB NOT NULL DEFAULT '{}',
    "canAutoExecute" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "risk_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "risk_assessments_transactionId_key" ON "risk_assessments"("transactionId");

-- CreateIndex
CREATE INDEX "risk_assessments_organizationId_idx" ON "risk_assessments"("organizationId");

-- CreateIndex
CREATE INDEX "risk_assessments_score_idx" ON "risk_assessments"("score");

-- CreateIndex
CREATE INDEX "risk_assessments_band_idx" ON "risk_assessments"("band");

-- CreateIndex
CREATE INDEX "risk_assessments_createdAt_idx" ON "risk_assessments"("createdAt");

-- AddForeignKey
ALTER TABLE "risk_assessments" ADD CONSTRAINT "risk_assessments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
