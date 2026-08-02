-- Education, Experience and Project become reachable without an account.
--
-- These three tables were created empty by 20260802140000 and have never held a
-- row (verified: SELECT COUNT(*) = 0 on each before this migration). Making
-- `userId` nullable therefore cannot lose data — there is none — and it lets
-- local single-user mode own entries with a NULL owner, exactly as
-- ApprovedAnswer already does for rows that predate accounts.
--
-- SQLite cannot relax a NOT NULL constraint in place, so each table is rebuilt.
-- Every rebuild copies all rows first; the copy is a no-op today and stays
-- correct if it is ever replayed against a populated database.
--
-- Nothing outside these three tables is touched.

PRAGMA foreign_keys=OFF;

CREATE TABLE "new_Education" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT,
  "school" TEXT NOT NULL,
  "degree" TEXT,
  "major" TEXT,
  "minor" TEXT,
  "startMonth" TEXT,
  "startYear" TEXT,
  "graduationMonth" TEXT,
  "graduationYear" TEXT,
  "gpa" TEXT,
  "educationLevel" TEXT,
  "relevantCoursework" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "Education_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Education" SELECT * FROM "Education";
DROP TABLE "Education";
ALTER TABLE "new_Education" RENAME TO "Education";
CREATE INDEX "Education_userId_idx" ON "Education"("userId");

CREATE TABLE "new_Experience" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT,
  "employer" TEXT NOT NULL,
  "title" TEXT,
  "location" TEXT,
  "startDate" TEXT,
  "endDate" TEXT,
  "currentlyEmployed" BOOLEAN NOT NULL DEFAULT false,
  "responsibilities" TEXT,
  "approvedBullets" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "Experience_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Experience" SELECT * FROM "Experience";
DROP TABLE "Experience";
ALTER TABLE "new_Experience" RENAME TO "Experience";
CREATE INDEX "Experience_userId_idx" ON "Experience"("userId");

CREATE TABLE "new_Project" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT,
  "name" TEXT NOT NULL,
  "startDate" TEXT,
  "endDate" TEXT,
  "technologies" TEXT,
  "description" TEXT,
  "approvedSkills" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Project" SELECT * FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE INDEX "Project_userId_idx" ON "Project"("userId");

PRAGMA foreign_keys=ON;
