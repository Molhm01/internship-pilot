// Resource-control contract for the headless fallback.
//
// These assertions exist because the cost of getting this wrong is not a wrong
// answer — it is a Chromium process sitting on the user's workstation. None of
// these tests launch a browser.

import { beforeEach, describe, expect, it } from "vitest";
import {
  isHeadlessTenantCoolingDown,
  markHeadlessTenantCooldown,
  resetHeadlessCooldowns,
  resolveWithHeadlessBrowser,
} from "@/lib/ats/headlessResolver";

beforeEach(() => resetHeadlessCooldowns());

describe("tenant cooldown", () => {
  it("puts a failing tenant on a cooldown instead of retrying every tick", () => {
    expect(isHeadlessTenantCoolingDown("icims:acme")).toBe(false);
    markHeadlessTenantCooldown("icims:acme");
    expect(isHeadlessTenantCoolingDown("icims:acme")).toBe(true);
  });

  it("expires the cooldown rather than blocking the tenant forever", () => {
    const now = Date.now();
    markHeadlessTenantCooldown("icims:acme", now);
    expect(isHeadlessTenantCoolingDown("icims:acme", now + 60_000)).toBe(true);
    expect(isHeadlessTenantCoolingDown("icims:acme", now + 7 * 60 * 60 * 1000)).toBe(false);
  });

  it("keeps cooldowns per tenant", () => {
    markHeadlessTenantCooldown("icims:acme");
    expect(isHeadlessTenantCoolingDown("icims:other")).toBe(false);
  });
});

describe("batch admission", () => {
  it("answers a cooling-down tenant from cache without launching anything", async () => {
    markHeadlessTenantCooldown("icims:acme");
    const outcomes = await resolveWithHeadlessBrowser([
      { tenantKey: "icims:acme", url: "https://acme.icims.com/jobs/search", companyName: "Acme" },
    ]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.jobs).toEqual([]);
    expect(outcomes[0]!.error).toMatch(/cooldown/i);
  });

  it("does nothing at all when every request is cooling down", async () => {
    markHeadlessTenantCooldown("a");
    markHeadlessTenantCooldown("b");
    const outcomes = await resolveWithHeadlessBrowser([
      { tenantKey: "a", url: "https://a.example.com/jobs", companyName: "A" },
      { tenantKey: "b", url: "https://b.example.com/jobs", companyName: "B" },
    ]);
    expect(outcomes.every((outcome) => outcome.error !== null)).toBe(true);
  });

  it("collapses repeated requests for one tenant into a single render", async () => {
    // Three signals from the same employer must not become three page renders.
    markHeadlessTenantCooldown("icims:acme");
    const outcomes = await resolveWithHeadlessBrowser([
      { tenantKey: "icims:acme", url: "https://acme.icims.com/jobs", companyName: "Acme" },
      { tenantKey: "icims:acme", url: "https://acme.icims.com/jobs", companyName: "Acme" },
      { tenantKey: "icims:acme", url: "https://acme.icims.com/jobs", companyName: "Acme" },
    ]);
    expect(outcomes).toHaveLength(1);
  });

  it("returns an empty list for an empty request set", async () => {
    expect(await resolveWithHeadlessBrowser([])).toEqual([]);
  });
});
