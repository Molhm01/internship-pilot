import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareResumeFormatSnapshots,
  evaluateResumeFormatPreservation,
  type ResumeFormatSnapshot,
} from "./layoutQa";

const preserved: ResumeFormatSnapshot = {
  pageCount: 1,
  pageWidth: 612,
  pageHeight: 792,
  minTextX: 30.5,
  maxTextRight: 586,
  fontNames: ["helveticaworld-regular", "ibmplexsans", "timesnewromanps-bolditalicmt"],
  fontHeights: [9, 10, 16],
  bulletXs: [48, 48, 48, 48],
  dateRightEdges: [578, 586, 585],
  activityXs: [42, 42, 42],
  medianLineGap: 12,
};

describe("master résumé format preservation", () => {
  it("accepts matching one-page typography, dates, bullets, margins, activities, and spacing", () => {
    expect(compareResumeFormatSnapshots(preserved, preserved)).toEqual([]);
  });

  it("rejects page overflow and master-format drift", () => {
    const altered: ResumeFormatSnapshot = {
      ...preserved,
      pageCount: 2,
      minTextX: 44,
      fontNames: ["arial"],
      bulletXs: [65, 72],
      dateRightEdges: [530],
      activityXs: [70],
      medianLineGap: 17,
    };
    const issues = compareResumeFormatSnapshots(altered, preserved).join(" ");

    expect(issues).toContain("requires one page");
    expect(issues).toContain("margins");
    expect(issues).toContain("font substitution");
    expect(issues).toContain("Bullet indentation");
    expect(issues).toContain("dates");
    expect(issues).toContain("activity rows");
    expect(issues).toContain("Line spacing");
  });

  it("reads the real master PDF as a one-page formatting baseline", async () => {
    const master = new Uint8Array(readFileSync(
      path.resolve(process.cwd(), "templates/master_resume_reference.pdf"),
    ));
    const result = await evaluateResumeFormatPreservation(master, master);

    expect(result.status).toBe("pass");
    expect(result.generated.pageCount).toBe(1);
    expect(result.generated.fontNames).toEqual(expect.arrayContaining([
      "ibmplexsans",
      "timesnewromanps-bolditalicmt",
    ]));
    expect(result.generated.bulletXs.length).toBeGreaterThan(0);
    expect(result.generated.dateRightEdges.length).toBeGreaterThan(0);
    expect(result.generated.activityXs.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the fixed Typst template tied to the master geometry", () => {
    const template = readFileSync(
      path.resolve(process.cwd(), "templates/resume-template.typ"),
      "utf8",
    );

    expect(template).toContain('set page(paper: "us-letter", margin: (left: 0.444in, right: 0.43in, y: 0.34in))');
    expect(template).toContain('set text(font: "IBM Plex Sans", size: 10pt');
    expect(template).toContain('text(font: "Times New Roman", size: 9pt, weight: "bold", style: "italic"');
    expect(template).toContain('grid(columns: (6pt, 1fr), column-gutter: 3pt, [•], [#value])');
    expect(template).toContain('grid(columns: (1fr, auto)');
  });
});
