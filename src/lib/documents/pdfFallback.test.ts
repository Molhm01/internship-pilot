import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractPdfText } from "@/lib/pdf";
import { evaluatePdfLayoutQa } from "@/lib/documents/layoutQa";
import {
  MASTER_ACTIVITIES,
  MASTER_EDUCATION,
  MASTER_EXPERIENCE,
  MASTER_PROJECTS,
  MASTER_SKILLS,
} from "@/lib/documents/masterResume";
import {
  compileCoverLetterPdfFallback,
  compileResumePdfFallback,
} from "@/lib/documents/pdfFallback";
import { evaluateStrictDocumentQa } from "@/lib/documents/qa";

describe("pdfFallback layout and QA safety", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tmpPdf(name: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pdf-fallback-test-"));
    tempDirs.push(dir);
    return path.join(dir, name);
  }

  it("keeps long contact headers (email + linkedin + work auth) inside safe margins and passes strict + layout QA", async () => {
    const bytes = await compileResumePdfFallback(
      {
        fullName: "Samira Pilot",
        email: "e2e.v2.1794797015@pilot.dev",
        phone: "(973) 555-0194",
        linkedin: "https://linkedin.com/in/samira-eng",
        workAuthorization: "Authorized to work in the United States",
        addressCity: "Clifton",
        addressState: "NJ",
      },
      {
        education: MASTER_EDUCATION,
        experience: MASTER_EXPERIENCE,
        projects: MASTER_PROJECTS,
        skills: MASTER_SKILLS,
        activities: MASTER_ACTIVITIES,
      },
      tmpPdf("resume-long-contact.pdf"),
    );

    const extracted = await extractPdfText(bytes);
    expect(extracted.pageCount).toBe(1);
    expect(extracted.text).toContain("e2e.v2.1794797015@pilot.dev");
    expect(extracted.text).toContain("(973) 555-0194");

    const layoutQa = await evaluatePdfLayoutQa(bytes, "resume");
    expect(layoutQa.issues).toEqual([]);
    expect(layoutQa.pageCount).toBe(1);

    const strictQa = evaluateStrictDocumentQa(
      extracted.text,
      ["EDUCATION", "EXPERIENCE", "PROJECTS", "SKILLS", "ACTIVITIES & LEADERSHIP"],
      ["New Jersey Institute of Technology", "Stevens Institute of Technology", "Software-Defined Radio ADS-B Receiver"],
      {
        kind: "resume",
        candidateName: "Samira Pilot",
        contactValues: ["e2e.v2.1794797015@pilot.dev", "(973) 555-0194"],
        requiredHeadings: ["EDUCATION", "EXPERIENCE", "PROJECTS", "SKILLS", "ACTIVITIES & LEADERSHIP"],
        requiredProjectTitles: MASTER_PROJECTS.map((p) => p.title),
        pageCount: extracted.pageCount,
      },
    );
    expect(strictQa.status).toBe("pass");
    expect(strictQa.issues).toEqual([]);
  });

  it("wraps very long names, emails, and LinkedIn URLs onto clean lines without margin overflow", async () => {
    const bytes = await compileResumePdfFallback(
      {
        fullName: "Alexandria Montgomery-Fitzwilliam III",
        email: "alexandria.montgomery.engineering.2026@university-example.edu",
        phone: "(973) 555-0188",
        linkedin: "https://www.linkedin.com/in/alexandria-montgomery-fitzwilliam-electrical-engineering",
        workAuthorization: "Authorized to work in the United States without sponsorship",
        addressCity: "Newark",
        addressState: "NJ",
      },
      {
        education: MASTER_EDUCATION,
        experience: MASTER_EXPERIENCE,
        projects: MASTER_PROJECTS,
        skills: MASTER_SKILLS,
        activities: MASTER_ACTIVITIES,
      },
      tmpPdf("resume-very-long-contact.pdf"),
    );

    const layoutQa = await evaluatePdfLayoutQa(bytes, "resume");
    expect(layoutQa.issues).toEqual([]);
    expect(layoutQa.pageCount).toBe(1);
  });

  it("keeps fallback cover letter with long contact/company inside safe margins and passes layout QA", async () => {
    const paragraphs = [
      "I am applying for the Electrical Engineering Intern position at Acme Autonomous Systems Corporation. The responsibilities and technical qualifications outlined in the current posting match the verified background presented below.",
      "My approved candidate profile documents hands-on embedded sensor work, C++ programming, and laboratory measurement procedures including analog signal testing, digital filtering, and automated data collection.",
      "Across coursework at Stevens Institute of Technology and New Jersey Institute of Technology, I designed and built 3D-printed enclosures, calibrated hardware prototypes, and verified PC and embedded systems under load.",
      "I would welcome the opportunity to discuss how my electrical and computer engineering training, PCB troubleshooting experience, and disciplined testing practices align with your summer internship team.",
    ];
    const bytes = await compileCoverLetterPdfFallback(
      {
        name: "Samira Pilot",
        contact: [
          "Clifton, NJ",
          "(973) 555-0194",
          "e2e.v2.1794797015@pilot.dev",
          "https://linkedin.com/in/samira-eng",
        ],
        date: "November 15, 2026",
        company: "Acme Autonomous Systems Corporation",
        jobTitle: "Electrical Engineering Intern",
        paragraphs,
      },
      tmpPdf("cover-letter.pdf"),
    );

    const extracted = await extractPdfText(bytes);
    expect(extracted.pageCount).toBe(1);
    const layoutQa = await evaluatePdfLayoutQa(bytes, "coverLetter");
    expect(layoutQa.issues).toEqual([]);
  });
});
