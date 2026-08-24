import { describe, expect, it } from "vitest";

import { approvedEmployerCsvUpdateData, type ApprovedEmployerRow } from "@/lib/employers/sync";

describe("approved employer registry sync", () => {
  it("cannot erase provider configuration or validated state", () => {
    const row = {
      employer: "Example Engineering",
      careersUrl: "https://example.test/careers",
      sector: "Engineering",
      careerDomain: "example.test",
      eeCpeFit: "High",
      verificationStatus: "verified",
      verificationBasis: "official site",
      verifiedDate: "2026-08-20",
      recommendedSearchTerms: "electrical intern",
      canonicalApplyRule: "official only",
    } as ApprovedEmployerRow;

    const update = approvedEmployerCsvUpdateData(row) as Record<string, unknown>;
    expect(update).not.toHaveProperty("atsType");
    expect(update).not.toHaveProperty("atsIdentifier");
    expect(update).not.toHaveProperty("atsConfigState");
    expect(update).not.toHaveProperty("atsValidatedAt");
    expect(update).not.toHaveProperty("lastCheckStatus");
    expect(update.careersUrl).toBe(row.careersUrl);
  });
});
