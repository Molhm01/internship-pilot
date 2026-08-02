import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("canonical destination resolver integration", () => {
  it.each([
    "src/lib/sync/ingest.ts",
    "src/lib/sync/queue.ts",
    "src/app/api/jobs/route.ts",
    "src/app/api/jobs/[id]/verify/route.ts",
  ])("uses the canonical resolver in %s", (relativePath) => {
    const source = readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
    expect(source).toContain("resolveOfficialJobDestination");
    expect(source).toContain("destinationPersistenceData");
  });

  it("uses the canonical final-destination policy before rendering Apply", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "src/lib/jobs/applicationUrl.ts"),
      "utf8",
    );
    expect(source).toContain("isValidOfficialApplicationUrl");
    expect(source).toContain("officialApplicationUrl");
  });
});
