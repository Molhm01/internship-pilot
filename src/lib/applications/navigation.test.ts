import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import {
  navigateToApplicationForm,
  DiagnosticExternalNavigationBlockedError,
} from "./navigation";

/**
 * Regression coverage for LOCAL_DIAGNOSTIC_MODE, added after a local
 * diagnostic session's own "Apply" test accidentally drove the real
 * application worker to navigate to Seagate's live careers site. These
 * tests never touch a real browser or network — `page.goto` is a spy that
 * would fail the test if it were ever called against a blocked URL.
 */

function fakePage(finalUrl: string): { page: Page; goto: ReturnType<typeof vi.fn> } {
  const goto = vi.fn().mockResolvedValue({ status: () => 200 });
  const page = {
    url: vi.fn().mockReturnValue(finalUrl),
    goto,
    evaluate: vi.fn().mockResolvedValue([]),
  } as unknown as Page;
  return { page, goto };
}

describe("LOCAL_DIAGNOSTIC_MODE navigation guard", () => {
  const originalMode = process.env.LOCAL_DIAGNOSTIC_MODE;

  it("blocks navigation to a real Greenhouse URL and never calls page.goto", async () => {
    process.env.LOCAL_DIAGNOSTIC_MODE = "true";
    try {
      const { page, goto } = fakePage("about:blank");
      await expect(
        navigateToApplicationForm(page, "https://boards.greenhouse.io/acme/jobs/12345", "greenhouse"),
      ).rejects.toBeInstanceOf(DiagnosticExternalNavigationBlockedError);
      expect(goto).not.toHaveBeenCalled();
    } finally {
      process.env.LOCAL_DIAGNOSTIC_MODE = originalMode;
    }
  });

  it("blocks navigation to a real Lever URL and never calls page.goto", async () => {
    process.env.LOCAL_DIAGNOSTIC_MODE = "true";
    try {
      const { page, goto } = fakePage("about:blank");
      await expect(
        navigateToApplicationForm(page, "https://jobs.lever.co/acme/abc-123", "lever"),
      ).rejects.toBeInstanceOf(DiagnosticExternalNavigationBlockedError);
      expect(goto).not.toHaveBeenCalled();
    } finally {
      process.env.LOCAL_DIAGNOSTIC_MODE = originalMode;
    }
  });

  it("blocks navigation to a real Workday URL and never calls page.goto", async () => {
    process.env.LOCAL_DIAGNOSTIC_MODE = "true";
    try {
      const { page, goto } = fakePage("about:blank");
      await expect(
        navigateToApplicationForm(page, "https://acme.wd1.myworkdayjobs.com/en-US/careers/job/12345", "workday"),
      ).rejects.toBeInstanceOf(DiagnosticExternalNavigationBlockedError);
      expect(goto).not.toHaveBeenCalled();
    } finally {
      process.env.LOCAL_DIAGNOSTIC_MODE = originalMode;
    }
  });

  it("produces the diagnostic_external_navigation_blocked error code", async () => {
    process.env.LOCAL_DIAGNOSTIC_MODE = "true";
    try {
      const { page } = fakePage("about:blank");
      try {
        await navigateToApplicationForm(page, "https://boards.greenhouse.io/acme/jobs/12345", "greenhouse");
        expect.unreachable("navigation should have been blocked");
      } catch (error) {
        expect(error).toBeInstanceOf(DiagnosticExternalNavigationBlockedError);
        expect((error as DiagnosticExternalNavigationBlockedError).message).toContain("diagnostic_external_navigation_blocked");
      }
    } finally {
      process.env.LOCAL_DIAGNOSTIC_MODE = originalMode;
    }
  });

  it("allows navigation to a localhost mock-ATS fixture", async () => {
    process.env.LOCAL_DIAGNOSTIC_MODE = "true";
    try {
      const { page, goto } = fakePage("http://localhost:3000/mock-ats/greenhouse-fillonly.html");
      const result = await navigateToApplicationForm(
        page,
        "http://localhost:3000/mock-ats/greenhouse-fillonly.html",
        "greenhouse",
      );
      expect(goto).toHaveBeenCalledWith(
        "http://localhost:3000/mock-ats/greenhouse-fillonly.html",
        expect.anything(),
      );
      expect(result.finalUrl).toBe("http://localhost:3000/mock-ats/greenhouse-fillonly.html");
    } finally {
      process.env.LOCAL_DIAGNOSTIC_MODE = originalMode;
    }
  });

  it("allows navigation to a 127.0.0.1 mock-ATS fixture", async () => {
    process.env.LOCAL_DIAGNOSTIC_MODE = "true";
    try {
      const { page, goto } = fakePage("http://127.0.0.1:3000/mock-ats/workday-multistep.html");
      await navigateToApplicationForm(
        page,
        "http://127.0.0.1:3000/mock-ats/workday-multistep.html",
        "workday",
      );
      expect(goto).toHaveBeenCalled();
    } finally {
      process.env.LOCAL_DIAGNOSTIC_MODE = originalMode;
    }
  });

  it("does not weaken normal (non-diagnostic) behavior — real URLs navigate fine when the flag is unset", async () => {
    delete process.env.LOCAL_DIAGNOSTIC_MODE;
    try {
      const { page, goto } = fakePage("https://boards.greenhouse.io/acme/jobs/12345");
      await navigateToApplicationForm(page, "https://boards.greenhouse.io/acme/jobs/12345", "greenhouse");
      expect(goto).toHaveBeenCalled();
    } finally {
      process.env.LOCAL_DIAGNOSTIC_MODE = originalMode;
    }
  });

  it("does not block real URLs when the flag is explicitly false", async () => {
    process.env.LOCAL_DIAGNOSTIC_MODE = "false";
    try {
      const { page, goto } = fakePage("https://boards.greenhouse.io/acme/jobs/12345");
      await navigateToApplicationForm(page, "https://boards.greenhouse.io/acme/jobs/12345", "greenhouse");
      expect(goto).toHaveBeenCalled();
    } finally {
      process.env.LOCAL_DIAGNOSTIC_MODE = originalMode;
    }
  });
});
