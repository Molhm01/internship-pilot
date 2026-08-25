import type { Page } from "playwright";
import type { AtsType, FillContext, FillResult } from "./types";
import { fillWithInternshipPilotExtension } from "./extensionFiller";

// The generic label-scanning engine (formFiller.ts) is ATS-agnostic by
// design — it reads accessible names/labels and now supports multi-step
// wizards (Next/Continue buttons across pages), rather than depending on
// any one platform's exact DOM. All 8 named ATS platforms are wired through
// it and tested against local mock fixtures shaped like that platform's
// typical flow: Greenhouse/Lever/Ashby as single-page guest-apply forms
// (scripts/test-application-agent.ts, scripts/test-autofill-fixtures.ts),
// Workday/iCIMS as multi-step wizards, and SmartRecruiters/SuccessFactors/
// Taleo covering relocation/sponsorship/availability fields and the
// terms-checkbox stop condition (all five: scripts/test-autofill-fixtures.ts
// sections 7-8, against the real public/mock-ats/*.html files over a plain
// HTTP fixture server — no database dependency, so this coverage stays
// reliable even when the local Prisma Dev instance is down).
//
// FIXTURE_TESTED means exactly that: the mock passes today. It is not a
// production-support claim — see productionFillEnabled below, which is
// deliberately narrower.
//
// Important honesty note: these mocks model TYPICAL field patterns for each
// platform, not a specific real employer's live instance — a real Workday
// tenant that requires creating a candidate account before applying, for
// example, will hit the login_required stop condition (a password field
// appearing) rather than silently failing, since that flow was never
// modeled or tested. Never submitted to a real employer site.
export const ATS_CAPABILITIES: Record<AtsType, "PRODUCTION_READY" | "LIVE_INSPECTED" | "FIXTURE_TESTED" | "NOT_IMPLEMENTED"> = {
  lever: "PRODUCTION_READY",
  greenhouse: "LIVE_INSPECTED",
  ashby: "FIXTURE_TESTED",
  workday: "FIXTURE_TESTED",
  icims: "FIXTURE_TESTED",
  smartrecruiters: "FIXTURE_TESTED",
  successfactors: "FIXTURE_TESTED",
  taleo: "FIXTURE_TESTED",
  unknown: "NOT_IMPLEMENTED",
};

export async function fillApplicationForAts(
  page: Page,
  atsType: AtsType,
  ctx: FillContext,
  runDir: string,
  beforeSubmit?: () => Promise<{ ok: boolean; reason?: string }>,
): Promise<FillResult> {
  const isLocalMock = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/mock-ats\//i.test(ctx.applyUrl);
  const productionFillEnabled = atsType === "greenhouse" || atsType === "lever" || atsType === "unknown";
  if (!productionFillEnabled && !isLocalMock) {
    return {
      status: "needs_user_action",
      stopReason: "unsupported_ats",
      answers: {},
    };
  }
  return fillWithInternshipPilotExtension(page, ctx, runDir, beforeSubmit);
}
