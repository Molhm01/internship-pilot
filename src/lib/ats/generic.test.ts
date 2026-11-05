import { afterEach, describe, expect, it, vi } from "vitest";
import { scanCareersPageForInternshipLinks } from "./generic";
import { listJobsForCompany } from "./index";

function htmlResponse(html: string, init?: { status?: number; headers?: Record<string, string> }) {
  return new Response(html, { status: init?.status ?? 200, headers: init?.headers });
}

// A thin shell: framework mount point, almost no server-rendered text.
const THIN_SHELL = `<!doctype html><html><head><script src="/app.js"></script></head><body><div id="root"></div><a href="/">Home</a></body></html>`;

// A shell with a full navigation bar: many anchors alone must not count as
// readable coverage.
const MANY_ANCHOR_SHELL = `<!doctype html><html><head><script src="/bundle.js"></script></head><body><div id="app"></div><nav>
${Array.from({ length: 50 }, (_, i) => `<a href="/nav/${i}">Menu item ${i}</a>`).join("\n")}
</nav></body></html>`;

const LANDING_TEXT = `We are a global engineering company with offices in forty countries. `
  .repeat(30);

// A readable careers landing page: real server-rendered content and links,
// but no job-listing structure - zero matches here is unvalidated coverage.
const READABLE_LANDING = `<!doctype html><html><body><h1>Careers</h1><p>${LANDING_TEXT}</p>
${Array.from({ length: 20 }, (_, i) => `<a href="/about/${i}">Learn more ${i}</a>`).join("\n")}
</body></html>`;

// A complete job board rendering an explicit empty state.
const EMPTY_BOARD = `<!doctype html><html><body><h1>Open positions</h1><p>${LANDING_TEXT}</p>
<div class="job-listings search-results"><p>No current openings match your search.</p></div>
${Array.from({ length: 12 }, (_, i) => `<a href="/jobs/category/${i}">Category ${i}</a>`).join("\n")}
</body></html>`;

// A complete job board with one internship posting.
const BOARD_WITH_INTERN = EMPTY_BOARD.replace(
  '<p>No current openings match your search.</p>',
  '<a href="/jobs/12345">Hardware Engineering Intern 2027</a>',
);

function customCompany(url = "https://example.com/careers") {
  return {
    name: "Example",
    atsType: "custom",
    atsIdentifier: null,
    careersUrl: url,
    lastETag: null,
    lastModified: null,
    contentHash: null,
  };
}

describe("scanCareersPageForInternshipLinks readability", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("marks a thin JS shell unreadable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(THIN_SHELL)));
    const res = await scanCareersPageForInternshipLinks("https://example.com/careers", "Example");
    expect(res.jobs).toHaveLength(0);
    expect(res.pageReadable).toBe(false);
    expect(res.completeEmptyListing).toBe(false);
  });

  it("a many-anchor JS shell is never a complete empty listing", async () => {
    // Nav text can make a shell look text-rich; anchor count and text volume
    // are not coverage evidence. The load-bearing guarantee is that such a
    // page can never report a verified empty board.
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(MANY_ANCHOR_SHELL)));
    const res = await scanCareersPageForInternshipLinks("https://example.com/careers", "Example");
    expect(res.jobs).toHaveLength(0);
    expect(res.completeEmptyListing).toBe(false);
  });

  it("marks fetch failures unreadable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    const res = await scanCareersPageForInternshipLinks("https://example.com/careers", "Example");
    expect(res.pageReadable).toBe(false);
  });

  it("keeps unchanged pages readable (contentHash short-circuit)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(EMPTY_BOARD)));
    const first = await scanCareersPageForInternshipLinks("https://example.com/careers", "Example");
    const second = await scanCareersPageForInternshipLinks("https://example.com/careers", "Example", {
      contentHash: first.contentHash,
    });
    expect(second.notModified).toBe(true);
    expect(second.pageReadable).toBe(true);
  });
});

describe("custom-board supported semantics", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a readable landing without listing evidence is unvalidated, not a zero", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(READABLE_LANDING)));
    const res = await listJobsForCompany(customCompany());
    expect(res.jobs).toHaveLength(0);
    expect(res.supported).toBe(false);
    expect(res.diagnostic).toMatch(/unvalidated coverage/);
  });

  it("a genuine complete empty job board is a credible zero", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(EMPTY_BOARD)));
    const res = await listJobsForCompany(customCompany());
    expect(res.jobs).toHaveLength(0);
    expect(res.supported).toBe(true);
  });

  it("a board with an intern posting is supported with the job parsed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(BOARD_WITH_INTERN)));
    const res = await listJobsForCompany(customCompany());
    expect(res.supported).toBe(true);
    expect(res.jobs.map((j) => j.title)).toContain("Hardware Engineering Intern 2027");
  });

  it("a JS shell is unsupported even though the page answers 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(MANY_ANCHOR_SHELL)));
    const res = await listJobsForCompany(customCompany());
    expect(res.supported).toBe(false);
  });
});
