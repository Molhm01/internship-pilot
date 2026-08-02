import "dotenv/config";
import { recheckOfficialUrl, verifyJob } from "@/lib/sync/verify";

let failures = 0;
function check(condition: boolean, message: string) {
  if (condition) {
    console.log(`  PASS: ${message}`);
  } else {
    console.error(`  FAIL: ${message}`);
    failures++;
  }
}

type MockResponse = { ok: boolean; status?: number; json: () => Promise<unknown> };

// A real fetch() Response always has a numeric `.status` and a `.headers`
// object with `.get()` — followRedirectChain() (used by recheckOfficialUrl)
// relies on both to decide whether a hop is a redirect. Filling these in
// here so the mock accurately represents what production code actually
// receives, rather than a partial shape that happens not to crash.
function toFullMockResponse(result: MockResponse): Response {
  return {
    ok: result.ok,
    status: result.status ?? (result.ok ? 200 : 404),
    json: result.json,
    headers: { get: () => null },
  } as unknown as Response;
}

function mockFetch(handler: (url: string) => MockResponse | null) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const result = handler(url);
    if (!result) return toFullMockResponse({ ok: false, status: 404, json: async () => null });
    return toFullMockResponse(result);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function main() {
  console.log("1) Matching Greenhouse posting -> Verified");
  {
    const restore = mockFetch((url) => {
      if (url.includes("boards-api.greenhouse.io/v1/boards/acme/jobs")) {
        return {
          ok: true,
          json: async () => ({
            jobs: [
              {
                title: "Software Engineering Intern",
                absolute_url: "https://boards.greenhouse.io/acme/jobs/123",
                location: { name: "New York, NY" },
                content: "<p>Full official description</p>",
              },
            ],
          }),
        };
      }
      return null;
    });
    try {
      const result = await verifyJob({
        title: "Software Engineering Intern",
        company: "Acme Corp",
        location: "New York, NY",
        workModel: "On Site",
      });
      check(result.status === "VERIFIED_OFFICIAL_AT_LAST_CHECK", `status is VERIFIED_OFFICIAL_AT_LAST_CHECK (got ${result.status})`);
      check(
        result.officialApplyUrl === "https://boards.greenhouse.io/acme/jobs/123",
        "officialApplyUrl captured from the matched posting",
      );
    } finally {
      restore();
    }
  }

  console.log("\n2) Matching title but conflicting location -> ACTIVE_SOURCE_LISTED with discrepancy reason");
  {
    const restore = mockFetch((url) => {
      if (url.includes("boards-api.greenhouse.io/v1/boards/acme/jobs")) {
        return {
          ok: true,
          json: async () => ({
            jobs: [
              {
                title: "Software Engineering Intern",
                absolute_url: "https://boards.greenhouse.io/acme/jobs/999",
                location: { name: "Austin, TX" },
                content: "desc",
              },
            ],
          }),
        };
      }
      return null;
    });
    try {
      const result = await verifyJob({
        title: "Software Engineering Intern",
        company: "Acme Corp",
        location: "New York, NY",
        workModel: "On Site",
      });
      check(result.status === "ACTIVE_SOURCE_LISTED", `status is ACTIVE_SOURCE_LISTED on location discrepancy (got ${result.status})`);
      check(result.reasonCode === "DESTINATION_LOCATION_DISCREPANCY", `reasonCode is DESTINATION_LOCATION_DISCREPANCY (got ${result.reasonCode})`);
      check(/differs/i.test(result.reason), `reason explains the discrepancy: "${result.reason}"`);
    } finally {
      restore();
    }
  }

  console.log("\n3) No matching posting anywhere -> ACTIVE_SOURCE_LISTED (mirror not found, not closed)");
  {
    const restore = mockFetch(() => null);
    try {
      const result = await verifyJob({
        title: "Mystery Intern Role",
        company: "Totally Unknown Startup Xyz",
        location: "Nowhere, ZZ",
        workModel: "On Site",
      });
      check(result.status === "ACTIVE_SOURCE_LISTED", `status is ACTIVE_SOURCE_LISTED when nothing is found (got ${result.status})`);
      check(result.reasonCode === "OFFICIAL_MIRROR_NOT_FOUND", `reasonCode is OFFICIAL_MIRROR_NOT_FOUND (got ${result.reasonCode})`);
      check(!result.officialApplyUrl, "no officialApplyUrl is fabricated when nothing was found");
    } finally {
      restore();
    }
  }

  console.log("\n4) Re-check of a previously verified posting that is now gone -> Closed signal");
  {
    const restore = mockFetch(() => ({ ok: false, json: async () => null }));
    try {
      const { stillOpen } = await recheckOfficialUrl("https://boards.greenhouse.io/acme/jobs/123");
      check(stillOpen === false, "a 404/removed posting is reported as no longer open");
    } finally {
      restore();
    }
  }

  console.log("\n5) Re-check of a posting that is still live -> stays open");
  {
    const restore = mockFetch(() => ({ ok: true, json: async () => null }));
    try {
      const { stillOpen } = await recheckOfficialUrl("https://boards.greenhouse.io/acme/jobs/123");
      check(stillOpen === true, "a still-reachable posting is reported as open");
    } finally {
      restore();
    }
  }

  console.log(failures === 0 ? "\nAll verification tests PASSED." : `\n${failures} verification test(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("Verification test crashed:", err);
  process.exitCode = 1;
});
