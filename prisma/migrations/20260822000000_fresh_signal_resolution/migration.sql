-- Fresh-radar official-resolution pipeline.
--
-- EmployerBoardResolution caches "which official board does this employer use",
-- keyed by a normalized company name, so a five-minute radar never re-crawls
-- the same employer. FreshSignalResolution records the per-signal outcome with a
-- concrete reason code and a retry schedule, so a fresh internship signal is
-- never silently dropped.

-- CreateTable
CREATE TABLE "EmployerBoardResolution" (
    "id" TEXT NOT NULL,
    "normalizedCompany" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "companyDomain" TEXT,
    "careersUrl" TEXT,
    "atsType" TEXT,
    "atsIdentifier" TEXT,
    "state" TEXT NOT NULL DEFAULT 'UNRESOLVED',
    "reasonCode" TEXT,
    "evidence" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployerBoardResolution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FreshSignalResolution" (
    "id" TEXT NOT NULL,
    "signalSource" TEXT NOT NULL,
    "signalJobId" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "normalizedCompany" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "location" TEXT,
    "sourcePostedAt" TIMESTAMP(3),
    "sourceCapturedAt" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "reasonCode" TEXT,
    "reasonDetail" TEXT,
    "resolutionPath" TEXT,
    "resolvedUrl" TEXT,
    "resolvedJobId" TEXT,
    "resolutionMs" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),

    CONSTRAINT "FreshSignalResolution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmployerBoardResolution_normalizedCompany_key" ON "EmployerBoardResolution"("normalizedCompany");

-- CreateIndex
CREATE INDEX "EmployerBoardResolution_state_nextAttemptAt_idx" ON "EmployerBoardResolution"("state", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "FreshSignalResolution_signalSource_signalJobId_key" ON "FreshSignalResolution"("signalSource", "signalJobId");

-- CreateIndex
CREATE INDEX "FreshSignalResolution_state_nextAttemptAt_idx" ON "FreshSignalResolution"("state", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "FreshSignalResolution_reasonCode_idx" ON "FreshSignalResolution"("reasonCode");

-- CreateIndex
CREATE INDEX "FreshSignalResolution_sourcePostedAt_idx" ON "FreshSignalResolution"("sourcePostedAt");
