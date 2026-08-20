import { describe, expect, it } from "vitest";
import { publicInternListPaginationUrls } from "./internListPublicRadar";

describe("Intern List public radar pagination", () => {
  it("discovers Webflow generated page parameters without hardcoding the prefix", () => {
    const html = `
      <a href="/swe-intern-list?abc123_page=2">2</a>
      <a href="https://www.intern-list.com/swe-intern-list?abc123_page=3">3</a>
      <a href="/other?abc123_page=4">ignore</a>
    `;
    expect(publicInternListPaginationUrls(html, "https://www.intern-list.com/swe-intern-list"))
      .toEqual([
        "https://www.intern-list.com/swe-intern-list?abc123_page=2",
        "https://www.intern-list.com/swe-intern-list?abc123_page=3",
      ]);
  });
});
