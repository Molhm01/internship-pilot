import { describe, expect, it } from "vitest";
import { looksClosedHtml } from "@/lib/sync/freshness";

describe("official posting freshness detection", () => {
  it.each([
    "This job is no longer available.",
    "The position has been filled.",
    "This job posting has expired.",
    "The requisition has been closed.",
  ])("recognizes an explicit closed signal: %s", (html) => {
    expect(looksClosedHtml(`<main>${html}</main>`)).toBe(true);
  });

  it("does not close a live page merely because help text mentions unavailable jobs", () => {
    const html = `
      <main><h1>Electrical Engineering Intern</h1><button>Apply now</button></main>
      <footer>If a job is no longer available, search our other openings.</footer>
    `;
    expect(looksClosedHtml(html)).toBe(false);
  });
});
