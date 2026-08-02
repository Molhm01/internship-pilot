import { describe, expect, it } from "vitest";
import { runAtsIngestion, sanitizeErrorCode, secureAtsUrl, type AtsEmployer } from "@/lib/sync/atsIngest";
import type { AtsJob } from "@/lib/ats/types";

// --- Fixture generation --------------------------------------------------
//
// 260 postings across 26 employers and all three vendors, with a realistic
// mix: qualifying internships, clear full-time roles, ambiguous seasonal
// titles, closed postings, and malformed rows. No network, no database.

function makeJob(over: Partial<AtsJob> & { sourceJobId: string; title: string; company: string }): AtsJob {
  return {
    requisitionId: null,
    location: "Austin, TX",
    workplaceType: null,
    applyUrl: `https://boards.example.com/${over.company.toLowerCase()}/jobs/${over.sourceJobId}`,
    description: "",
    postedAt: null,
    ...over,
  };
}

const VENDORS = ["greenhouse", "lever", "ashby"] as const;

function buildFixture(): { employers: AtsEmployer[]; boards: Map<string, AtsJob[]> } {
  const employers: AtsEmployer[] = [];
  const boards = new Map<string, AtsJob[]>();

  for (let e = 0; e < 26; e++) {
    const name = `Employer${e}`;
    const atsType = VENDORS[e % 3];
    employers.push({ name, atsType, atsIdentifier: `employer${e}` });

    const jobs: AtsJob[] = [];
    for (let j = 0; j < 10; j++) {
      const id = `${e}-${j}`;
      if (j < 5) {
        // 5 qualifying internships per employer = 130 total
        jobs.push(makeJob({ sourceJobId: id, title: `Software Engineer Intern ${j}`, company: name }));
      } else if (j < 8) {
        // 3 clear full-time roles per employer = 78 total
        jobs.push(makeJob({ sourceJobId: id, title: `Senior Software Engineer ${j}`, company: name }));
      } else if (j === 8) {
        // 1 ambiguous seasonal title per employer = 26 total
        jobs.push(makeJob({ sourceJobId: id, title: "Summer Analyst", company: name }));
      } else {
        // 1 malformed row per employer = 26 total (no title)
        jobs.push(makeJob({ sourceJobId: id, title: "", company: name }));
      }
    }
    boards.set(name, jobs);
  }
  return { employers, boards };
}

function fixtureRunner() {
  const { employers, boards } = buildFixture();
  const listJobs = async (employer: AtsEmployer) => boards.get(employer.name) ?? [];
  return { employers, boards, listJobs };
}

/** Records every persistence call so tests can assert on identity/dedup. */
function recordingPersist() {
  const calls: Array<{ key: string; classification: string }> = [];
  const store = new Set<string>();
  const persist = async (args: Parameters<typeof import("@/lib/sync/ingest").upsertClassifiedAtsJob>[0]) => {
    const key = `${args.source}::${args.job.sourceJobId}`;
    calls.push({ key, classification: args.classification });
    if (store.has(key)) return "updated" as const;
    store.add(key);
    return "new" as const;
  };
  return { calls, store, persist };
}

describe("runAtsIngestion — discovery completeness", () => {
  it("fetches every employer's board and discovers all 260 fixture rows", async () => {
    const { employers, listJobs } = fixtureRunner();
    const { persist } = recordingPersist();

    const m = await runAtsIngestion(employers, { listJobs, persist, throttleMs: 0 });

    expect(m.employersChecked).toBe(26);
    expect(m.employersWithBoard).toBe(26);
    expect(m.rowsDiscovered).toBe(260);
  });

  it("honours --limit without silently capping a full run", async () => {
    const { employers, listJobs } = fixtureRunner();
    const { persist } = recordingPersist();

    const limited = await runAtsIngestion(employers, { listJobs, persist, throttleMs: 0, limit: 5 });
    expect(limited.employersChecked).toBe(5);
    expect(limited.rowsDiscovered).toBe(50);

    const full = await runAtsIngestion(employers, { listJobs, persist, throttleMs: 0 });
    expect(full.employersChecked).toBe(26);
  });
});

describe("runAtsIngestion — classification routing", () => {
  it("persists qualifying internships and excludes clear full-time roles", async () => {
    const { employers, listJobs } = fixtureRunner();
    const { calls, persist } = recordingPersist();

    const m = await runAtsIngestion(employers, { listJobs, persist, throttleMs: 0 });

    expect(m.qualifying).toBe(130); // 5 per employer
    expect(m.notInternship).toBe(78); // 3 per employer
    expect(m.inserted).toBe(130);
    expect(calls.every((c) => c.classification === "QUALIFYING_INTERNSHIP")).toBe(true);
  });

  it("counts uncertain records as reviewable rather than dropping them", async () => {
    const { employers, listJobs } = fixtureRunner();
    const { persist } = recordingPersist();

    const m = await runAtsIngestion(employers, { listJobs, persist, throttleMs: 0 });

    expect(m.uncertain).toBe(26);
    expect(m.failuresByReason.REVIEW_UNCERTAIN).toBe(26);
  });

  it("accounts for every discovered row in exactly one bucket", async () => {
    const { employers, listJobs } = fixtureRunner();
    const { persist } = recordingPersist();

    const m = await runAtsIngestion(employers, { listJobs, persist, throttleMs: 0 });

    const classified = m.qualifying + m.notInternship + m.uncertain + m.closed + m.parseFailures;
    expect(classified + m.duplicatesPrevented).toBe(m.rowsDiscovered);
  });
});

describe("runAtsIngestion — resilience", () => {
  it("a single malformed row does not stop the import", async () => {
    const { employers, listJobs } = fixtureRunner();
    const { persist } = recordingPersist();

    const m = await runAtsIngestion(employers, { listJobs, persist, throttleMs: 0 });

    expect(m.parseFailures).toBe(26); // the untitled rows
    expect(m.inserted).toBe(130); // every good row still landed
  });

  it("a persistence failure on one record does not abort the run", async () => {
    const { employers, listJobs } = fixtureRunner();
    let n = 0;
    const persist = async () => {
      n += 1;
      if (n === 3) throw new Error("database is locked");
      return "new" as const;
    };

    const m = await runAtsIngestion(employers, { listJobs, persist, throttleMs: 0 });

    expect(m.persistenceFailures).toBe(1);
    expect(m.inserted).toBe(129);
    expect(m.failuresByReason.DATABASE_ERROR).toBe(1);
  });

  it("an unreachable board is recorded and the run continues", async () => {
    const { employers, boards } = fixtureRunner();
    const listJobs = async (employer: AtsEmployer) => {
      if (employer.name === "Employer3") throw new Error("fetch timeout");
      return boards.get(employer.name) ?? [];
    };
    const { persist } = recordingPersist();

    const m = await runAtsIngestion(employers, { listJobs, persist, throttleMs: 0 });

    expect(m.employersFailed).toBe(1);
    expect(m.employersChecked).toBe(26);
    expect(m.rowsDiscovered).toBe(250); // 260 minus the one failed board
    expect(m.failuresByReason.BOARD_FETCH_TIMEOUT).toBe(1);
  });
});

describe("runAtsIngestion — deduplication", () => {
  it("prevents duplicates when two boards expose the same canonical URL", async () => {
    const employers: AtsEmployer[] = [
      { name: "Acme", atsType: "greenhouse", atsIdentifier: "acme" },
      { name: "Acme", atsType: "lever", atsIdentifier: "acme-inc" },
    ];
    const shared = "https://boards.example.com/acme/jobs/500";
    const listJobs = async () => [
      makeJob({ sourceJobId: "500", title: "Software Engineer Intern", company: "Acme", applyUrl: shared }),
    ];
    const { persist } = recordingPersist();

    const m = await runAtsIngestion(employers, { listJobs, persist, throttleMs: 0 });

    expect(m.rowsDiscovered).toBe(2);
    expect(m.uniqueRows).toBe(1);
    expect(m.duplicatesPrevented).toBe(1);
    expect(m.inserted).toBe(1);
  });

  it("treats tracking-parameter variants of one posting as a single record", async () => {
    const employers: AtsEmployer[] = [{ name: "Acme", atsType: "greenhouse", atsIdentifier: "acme" }];
    const listJobs = async () => [
      makeJob({
        sourceJobId: "a",
        title: "Data Engineer Intern",
        company: "Acme",
        applyUrl: "https://boards.example.com/acme/jobs/9?utm_source=newsletter",
      }),
      makeJob({
        sourceJobId: "b",
        title: "Data Engineer Intern",
        company: "Acme",
        applyUrl: "https://boards.example.com/acme/jobs/9",
      }),
    ];
    const { persist } = recordingPersist();

    const m = await runAtsIngestion(employers, { listJobs, persist, throttleMs: 0 });

    expect(m.duplicatesPrevented).toBe(1);
    expect(m.inserted).toBe(1);
  });

  it("keeps the same title in different cities as separate postings", async () => {
    const employers: AtsEmployer[] = [{ name: "Acme", atsType: "greenhouse", atsIdentifier: "acme" }];
    const listJobs = async () => [
      makeJob({
        sourceJobId: "aus",
        title: "Software Engineer Intern",
        company: "Acme",
        location: "Austin, TX",
        applyUrl: "https://boards.example.com/acme/jobs/aus",
      }),
      makeJob({
        sourceJobId: "bos",
        title: "Software Engineer Intern",
        company: "Acme",
        location: "Boston, MA",
        applyUrl: "https://boards.example.com/acme/jobs/bos",
      }),
    ];
    const { persist } = recordingPersist();

    const m = await runAtsIngestion(employers, { listJobs, persist, throttleMs: 0 });

    expect(m.duplicatesPrevented).toBe(0);
    expect(m.inserted).toBe(2);
  });
});

describe("runAtsIngestion — official URL requirement", () => {
  it("rejects a posting with no application URL and says why", async () => {
    const employers: AtsEmployer[] = [{ name: "Acme", atsType: "greenhouse", atsIdentifier: "acme" }];
    const listJobs = async () => [
      makeJob({ sourceJobId: "x", title: "Software Engineer Intern", company: "Acme", applyUrl: "" }),
    ];
    const { persist } = recordingPersist();

    const m = await runAtsIngestion(employers, { listJobs, persist, throttleMs: 0 });

    expect(m.inserted).toBe(0);
    expect(m.failuresByReason.MISSING_OFFICIAL_URL).toBe(1);
  });

  it("confirms a direct official URL for every persisted internship", async () => {
    const { employers, listJobs } = fixtureRunner();
    const { persist } = recordingPersist();

    const m = await runAtsIngestion(employers, { listJobs, persist, throttleMs: 0 });

    expect(m.officialUrlsConfirmed).toBe(m.qualifying);
  });
});

describe("runAtsIngestion — idempotency and dry-run", () => {
  it("a repeated sync updates rather than duplicating", async () => {
    const { employers, listJobs } = fixtureRunner();
    const { persist, store } = recordingPersist();

    const first = await runAtsIngestion(employers, { listJobs, persist, throttleMs: 0 });
    const second = await runAtsIngestion(employers, { listJobs, persist, throttleMs: 0 });

    expect(first.inserted).toBe(130);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(130);
    expect(store.size).toBe(130); // no growth on the second run
  });

  it("dry-run classifies and counts but persists nothing", async () => {
    const { employers, listJobs } = fixtureRunner();
    const { calls, persist } = recordingPersist();

    const m = await runAtsIngestion(employers, { listJobs, persist, throttleMs: 0, dryRun: true });

    expect(m.qualifying).toBe(130);
    expect(m.inserted).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("sanitizeErrorCode", () => {
  it("reduces errors to short labels without leaking payloads", () => {
    expect(sanitizeErrorCode(new Error("connection timeout after 20000ms"))).toBe("TIMEOUT");
    expect(sanitizeErrorCode(new Error("UNIQUE constraint failed: Job.id"))).toBe("UNIQUE_CONSTRAINT");
    expect(sanitizeErrorCode("weird")).toBe("UNKNOWN_ERROR");
  });

  it("never returns the raw message for an arbitrary failure", () => {
    const secret = "token=abc123 description=<very long job text>";
    expect(sanitizeErrorCode(new Error(secret))).not.toContain("abc123");
  });
});

describe("secureAtsUrl", () => {
  it("REGRESSION: upgrades an http board URL so it survives the https-only destination policy", () => {
    // CannonDesign's Greenhouse board advertises http, which left a real
    // internship imported with no usable application URL.
    expect(secureAtsUrl("http://www.cannondesign.com/careers/?gh_jid=8568074002")).toBe(
      "https://www.cannondesign.com/careers/?gh_jid=8568074002",
    );
  });

  it("preserves www and the exact path, unlike the dedup canonicalizer", () => {
    expect(secureAtsUrl("https://www.example.com/careers/?gh_jid=1")).toBe(
      "https://www.example.com/careers/?gh_jid=1",
    );
  });

  it("rejects non-web schemes and empty values", () => {
    expect(secureAtsUrl("mailto:jobs@example.com")).toBeNull();
    expect(secureAtsUrl("")).toBeNull();
    expect(secureAtsUrl(null)).toBeNull();
    expect(secureAtsUrl("not a url")).toBeNull();
  });
});
