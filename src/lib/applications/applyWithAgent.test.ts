import { describe, expect, it, vi } from "vitest";
import type { StoredGeneratedDocument } from "@/lib/documents/client";
import { applyEligibility, applyWithApplicationAgent, newestValidDocument } from "./applyWithAgent";

function storedDocument(
  overrides: Partial<StoredGeneratedDocument> & Pick<StoredGeneratedDocument, "id" | "type">,
): StoredGeneratedDocument {
  return {
    version: 1,
    qaStatus: "pass",
    qaIssues: null,
    keywordClassification: null,
    tailoringStatus: "tailored",
    tailoringAudit: null,
    identityVerified: true,
    createdAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

const RESUME = storedDocument({ id: "doc-resume", type: "resume", version: 3 });
const COVER_LETTER = storedDocument({ id: "doc-cover", type: "coverLetter", version: 2 });

function bundleInput() {
  return {
    websiteJobId: "job-42",
    company: "Northwind Robotics",
    jobTitle: "Software Engineering Intern",
    jobDescription: "Build things.",
    officialApplicationUrl: "https://boards.greenhouse.io/northwind/jobs/9911",
    documents: [RESUME, COVER_LETTER],
    coverLetterRequired: false,
  };
}

function dependencies(overrides: Parameters<typeof applyWithApplicationAgent>[1] = {}) {
  const sendBundle = vi.fn().mockResolvedValue({
    bundleId: "bundle-1",
    storedDocuments: ["resume", "cover_letter"],
    storedAt: "2026-08-02T09:00:00.000Z",
  });
  const openWindow = vi.fn();
  return {
    sendBundle,
    openWindow,
    all: {
      fetchPdf: vi.fn(async (id: string) => new Blob([`pdf-bytes-${id}`], { type: "application/pdf" })),
      probeBridge: vi.fn().mockResolvedValue(true),
      sendBundle,
      openWindow,
      ...overrides,
    } as Parameters<typeof applyWithApplicationAgent>[1],
  };
}

describe("document selection", () => {
  it("picks the newest QA-passed identity-verified version", () => {
    const documents = [
      storedDocument({ id: "old", type: "resume", version: 1 }),
      storedDocument({ id: "new", type: "resume", version: 4 }),
      storedDocument({ id: "failed", type: "resume", version: 9, qaStatus: "fail" }),
      storedDocument({ id: "unverified", type: "resume", version: 8, identityVerified: false }),
    ];
    expect(newestValidDocument(documents, "resume")?.id).toBe("new");
  });

  it("returns null rather than an unusable document", () => {
    expect(newestValidDocument([storedDocument({ id: "x", type: "resume", qaStatus: "fail" })], "resume")).toBeNull();
  });
});

describe("apply eligibility", () => {
  it("is ready when the URL, the résumé, and the extension are all present", () => {
    expect(
      applyEligibility({
        officialApplicationUrl: "https://boards.greenhouse.io/x/jobs/1",
        documents: [RESUME],
        coverLetterRequired: false,
        bridgeAvailable: true,
      }),
    ).toEqual({ ready: true });
  });

  it("names the missing official application URL", () => {
    const result = applyEligibility({
      officialApplicationUrl: null,
      documents: [RESUME],
      coverLetterRequired: false,
      bridgeAvailable: true,
    });
    expect(result).toMatchObject({ ready: false });
    expect(result.ready === false && result.reason).toContain("has not been resolved");
  });

  it("names the missing tailored résumé", () => {
    const result = applyEligibility({
      officialApplicationUrl: "https://boards.greenhouse.io/x/jobs/1",
      documents: [],
      coverLetterRequired: false,
      bridgeAvailable: true,
    });
    expect(result.ready === false && result.reason).toContain("tailored résumé");
  });

  it("requires a cover letter only when the job asks for one", () => {
    const withoutCover = {
      officialApplicationUrl: "https://boards.greenhouse.io/x/jobs/1",
      documents: [RESUME],
      bridgeAvailable: true,
    };
    expect(applyEligibility({ ...withoutCover, coverLetterRequired: false })).toEqual({ ready: true });
    const required = applyEligibility({ ...withoutCover, coverLetterRequired: true });
    expect(required.ready === false && required.reason).toContain("cover letter");
  });

  it("names the missing extension", () => {
    const result = applyEligibility({
      officialApplicationUrl: "https://boards.greenhouse.io/x/jobs/1",
      documents: [RESUME],
      coverLetterRequired: false,
      bridgeAvailable: false,
    });
    expect(result.ready === false && result.reason).toContain("extension is not responding");
  });
});

describe("applying with the Application Agent", () => {
  it("transfers both tailored documents with their bytes, filenames, and MIME types", async () => {
    const { sendBundle, all } = dependencies();
    await applyWithApplicationAgent(bundleInput(), all);

    const sent = sendBundle.mock.calls[0]![0] as {
      company: string;
      jobTitle: string;
      websiteJobId: string;
      officialApplicationUrl: string;
      documents: Array<{ kind: string; filename: string; mimeType: string; bytes: ArrayBuffer }>;
    };
    expect(sent.company).toBe("Northwind Robotics");
    expect(sent.jobTitle).toBe("Software Engineering Intern");
    expect(sent.websiteJobId).toBe("job-42");
    expect(sent.officialApplicationUrl).toBe("https://boards.greenhouse.io/northwind/jobs/9911");
    expect(sent.documents.map((document) => document.kind)).toEqual(["resume", "cover_letter"]);
    for (const document of sent.documents) {
      expect(document.mimeType).toBe("application/pdf");
      expect(document.filename).toMatch(/\.pdf$/);
      expect(document.bytes.byteLength).toBeGreaterThan(0);
    }
    expect(sent.documents[0]!.filename).toContain("Resume");
    expect(sent.documents[1]!.filename).toContain("Cover-Letter");
  });

  it("opens the official URL only after the extension acknowledges", async () => {
    const order: string[] = [];
    const openWindow = vi.fn(() => order.push("open"));
    const sendBundle = vi.fn(async () => {
      order.push("send");
      return { bundleId: "b", storedDocuments: ["resume" as const], storedAt: "2026-08-02T09:00:00.000Z" };
    });
    await applyWithApplicationAgent(bundleInput(), {
      fetchPdf: vi.fn(async () => new Blob(["pdf"], { type: "application/pdf" })),
      probeBridge: vi.fn().mockResolvedValue(true),
      sendBundle,
      openWindow,
    });
    expect(order).toEqual(["send", "open"]);
    expect(openWindow).toHaveBeenCalledWith(
      "https://boards.greenhouse.io/northwind/jobs/9911",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("does not open the employer page when the extension refuses the bundle", async () => {
    const openWindow = vi.fn();
    await expect(
      applyWithApplicationAgent(bundleInput(), {
        fetchPdf: vi.fn(async () => new Blob(["pdf"], { type: "application/pdf" })),
        probeBridge: vi.fn().mockResolvedValue(true),
        sendBundle: vi.fn().mockRejectedValue(new Error("storage full")),
        openWindow,
      }),
    ).rejects.toThrow("storage full");
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("refuses to start when the extension is not listening", async () => {
    const sendBundle = vi.fn();
    const openWindow = vi.fn();
    await expect(
      applyWithApplicationAgent(bundleInput(), {
        fetchPdf: vi.fn(),
        probeBridge: vi.fn().mockResolvedValue(false),
        sendBundle,
        openWindow,
      }),
    ).rejects.toThrow(/extension is not responding/);
    expect(sendBundle).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("puts no document content in the opened URL", async () => {
    const { openWindow, all } = dependencies();
    await applyWithApplicationAgent(bundleInput(), all);
    const opened = String(openWindow.mock.calls[0]![0]);
    expect(opened).toBe("https://boards.greenhouse.io/northwind/jobs/9911");
    expect(opened).not.toContain("#");
    expect(opened).not.toMatch(/base64|resume|cover/i);
  });
});
