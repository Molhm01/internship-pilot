import { detectAtsForCareersPage } from "@/lib/ats/detect";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function findCareersLink(website: string): Promise<string | null> {
  try {
    const res = await fetch(website, {
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const anchorPattern = /<a\s+[^>]*href="([^"]+)"[^>]*>([^<]{2,60})<\/a>/gi;
    let match: RegExpExecArray | null;
    while ((match = anchorPattern.exec(html))) {
      const [, href, text] = match;
      if (/career|jobs?\b|opportunities/i.test(text) || /career|\/jobs?(\/|$)/i.test(href)) {
        try {
          return new URL(href, website).toString();
        } catch {
          continue;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

export type FirmConfirmation = {
  careersUrl: string | null;
  atsType: string | null;
  atsIdentifier: string | null;
};

// Step 3+4 of the Milestone 2 pipeline: given a website Google already
// confirmed belongs to this business, find its Careers/Jobs page and detect
// which ATS (if any) it uses. Returns nulls rather than guessing when we
// can't find a real careers link.
export async function confirmAndDetect(website: string): Promise<FirmConfirmation> {
  const careersUrl = await findCareersLink(website);
  if (!careersUrl) return { careersUrl: null, atsType: null, atsIdentifier: null };

  const detected = await detectAtsForCareersPage(careersUrl);
  return {
    careersUrl,
    atsType: detected.atsType === "unknown" ? "custom" : detected.atsType,
    atsIdentifier: detected.atsIdentifier,
  };
}
