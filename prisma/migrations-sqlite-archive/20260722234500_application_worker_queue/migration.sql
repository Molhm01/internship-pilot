-- A nullable unique key makes duplicate-click protection atomic across the
-- web server and the background application worker. Terminal runs clear it.
ALTER TABLE "ApplicationRun" ADD COLUMN "activeKey" TEXT;

CREATE UNIQUE INDEX "ApplicationRun_activeKey_key" ON "ApplicationRun"("activeKey");
