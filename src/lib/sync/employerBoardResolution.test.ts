import { afterEach, describe, expect, it, vi } from "vitest";

import { discoverProviderFromPublishedCareersPage } from "@/lib/sync/employerBoardResolution";

afterEach(() => vi.unstubAllGlobals());

describe("exact employer-approved careers pages", () => {
  it("detects the board linked by a case-sensitive approved path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        url: "https://www.marathonpetroleum.com/Jobs/",
        text: async () =>
          '<a href="https://mpc.wd1.myworkdayjobs.com/MPCCareers">Apply Today</a>',
      })) as unknown as typeof fetch,
    );

    await expect(
      discoverProviderFromPublishedCareersPage(
        {
          name: "Marathon Petroleum",
          careersUrl: "https://www.marathonpetroleum.com/Jobs/",
          atsType: "custom",
          atsIdentifier: null,
        },
        "marathonpetroleum.com",
      ),
    ).resolves.toMatchObject({
      atsType: "workday",
      atsIdentifier: "mpc.wd1/MPCCareers",
      careersUrl: "https://www.marathonpetroleum.com/Jobs/",
      origin: "approved_company",
    });
  });
});
