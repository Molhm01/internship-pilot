import { describe, expect, it } from "vitest";
import { computeActiveFeed } from "@/lib/jobs/sourcePolicy";
import { directAtsProfile } from "@/lib/sync/ingest";

const VENDORS = ["greenhouse", "lever", "ashby", "smartrecruiters", "workday"] as const;

describe("direct official jobs are visible in the active feed", () => {
  it("shows verified direct ATS jobs", () => {
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

  it("keeps Pending ATS rows hidden until the direct-source repair promotes them", () => {
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

  it("visibility never depends on an AI score or tailored document", () => {
    const profile = directAtsProfile("lever");
    expect(
      computeActiveFeed({
        source: "lever",
        verificationStatus: profile.verificationStatus,
        company: "Unscored Employer",
      }),
    ).toBe(true);
  });

  it("keeps demo/fixture employers out of the feed", () => {
    const profile = directAtsProfile("greenhouse");
    expect(
      computeActiveFeed({
        source: "greenhouse",
        verificationStatus: profile.verificationStatus,
        company: "Test Fixture Co",
      }),
    ).toBe(false);
  });

  it("hides aggregator rows even when legacy records were previously active", () => {
    for (const source of ["jobright", "simplify", "intern-list"]) {
      expect(
        computeActiveFeed({ source, verificationStatus: "Pending", company: "Legacy Employer" }),
      ).toBe(false);
      expect(
        computeActiveFeed({
          source,
          verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
          company: "Legacy Employer",
        }),
      ).toBe(false);
    }
  });
});
