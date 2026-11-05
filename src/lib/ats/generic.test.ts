import { afterEach, describe, expect, it, vi } from "vitest";
import { scanCareersPageForInternshipLinks } from "./generic";

function htmlResponse(html: string, init?: { status?: number; headers?: Record<string, string> }) {
  return new Response(html, { status: init?.status ?? 200, headers: init?.headers });
}

const SHELL = `<!doctype html><html><head><script src="/app.js"></script></head><body><div id="root"></div><a href="/">Home</a></body></html>`;

const STATIC_NO_INTERN = `<!doctype html><html><body>
${Array.from({ length: 15 }, (_, i) => `<a href="/jobs/${i}">Senior Engineer ${i}</a>`).join("\n")}
</body></html>`;

const STATIC_WITH_INTERN = STATIC_NO_INTERN.replace(
  '<a href="/jobs/0">Senior Engineer 0</a>',
  '<a href="/jobs/intern-1">Hardware Engineering Intern 2027</a>',
);

describe("scanCareersPageForInternshipLinks readability", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("marks a JS shell unreadable rather than a false-success zero", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(SHELL)));
    const res = await scanCareersPageForInternshipLinks("https://example.com/careers", "Example");
    expect(res.jobs).toHaveLength(0);
    expect(res.pageReadable).toBe(false);
  });

  it("treats a readable page with no intern links as a credible zero", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(STATIC_NO_INTERN)));
    const res = await scanCareersPageForInternshipLinks("https://example.com/careers", "Example");
    expect(res.jobs).toHaveLength(0);
    expect(res.pageReadable).toBe(true);
  });

  it("parses intern links from a readable page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(STATIC_WITH_INTERN)));
    const res = await scanCareersPageForInternshipLinks("https://example.com/careers", "Example");
    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].title).toBe("Hardware Engineering Intern 2027");
    expect(res.pageReadable).toBe(true);
  });

  it("marks fetch failures unreadable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    const res = await scanCareersPageForInternshipLinks("https://example.com/careers", "Example");
    expect(res.pageReadable).toBe(false);
  });

  it("keeps unchanged pages readable (contentHash short-circuit)", async () => {
    const html = STATIC_NO_INTERN;
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(html)));
    const first = await scanCareersPageForInternshipLinks("https://example.com/careers", "Example");
    const second = await scanCareersPageForInternshipLinks("https://example.com/careers", "Example", {
      contentHash: first.contentHash,
    });
    expect(second.notModified).toBe(true);
    expect(second.pageReadable).toBe(true);
  });
});
