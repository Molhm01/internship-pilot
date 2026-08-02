import { describe, expect, it } from "vitest";
import { computeActiveFeed } from "@/lib/jobs/sourcePolicy";
import { directAtsProfile } from "@/lib/sync/ingest";

const VENDORS = ["greenhouse", "lever", "ashby"] as const;

describe("direct-ATS jobs are visible in the active feed", () => {
  it("REGRESSION: an ATS job is active — it used to be written as Pending and vanish", () => {
    // ingestAtsJobs previously wrote every ATS job with verificationStatus
    // "Pending". ATS sources are not "trusted aggregators", so
    // computeActiveFeed returned false and ATS-ingested jobs were invisible.
    for (const vendor of VENDORS) {
      const profile = directAtsProfile(vendor);
      expect(
        computeActiveFeed({
          source: vendor,
          verificationStatus: profile.verificationStatus,
          company: "Acme Robotics",
        }),
      ).toBe(true);
    }
  });

  it("the old Pending profile would NOT have been visible for an ATS source", () => {
    for (const vendor of VENDORS) {
      expect(
        computeActiveFeed({ source: vendor, verificationStatus: "Pending", company: "Acme Robotics" }),
      ).toBe(false);
    }
  });

  it("records the ATS board as the verification method and reason", () => {
    const profile = directAtsProfile("greenhouse");
    expect(profile.verificationStatus).toBe("VERIFIED_OFFICIAL_AT_LAST_CHECK");
    expect(profile.reasonCode).toBe("OFFICIAL_ATS_BOARD");
    expect(profile.verificationMethod).toBe("greenhouse-board-api");
  });

  it("visibility never depends on an AI score or a tailored document", () => {
    // computeActiveFeed takes only source, verificationStatus, and company —
    // there is structurally no way for a missing score to hide a job.
    const profile = directAtsProfile("lever");
    const visible = computeActiveFeed({
      source: "lever",
      verificationStatus: profile.verificationStatus,
      company: "Unscored Employer",
    });
    expect(visible).toBe(true);
  });

  it("still keeps demo/fixture employers out of the feed", () => {
    const profile = directAtsProfile("greenhouse");
    expect(
      computeActiveFeed({
        source: "greenhouse",
        verificationStatus: profile.verificationStatus,
        company: "Test Fixture Co",
      }),
    ).toBe(false);
  });

  it("legacy intern-list records stay visible after the migration", () => {
    // The migration must not evict anything already in the feed.
    expect(
      computeActiveFeed({ source: "intern-list", verificationStatus: "Pending", company: "Legacy Employer" }),
    ).toBe(true);
    expect(
      computeActiveFeed({
        source: "intern-list",
        verificationStatus: "ACTIVE_SOURCE_LISTED",
        company: "Legacy Employer",
      }),
    ).toBe(true);
  });
});
