export type AtsDetectionResult = { atsType: string; atsIdentifier: string | null };

type Pattern = { atsType: string; regex: RegExp; extractId: (m: RegExpMatchArray) => string };

const PATTERNS: Pattern[] = [
  { atsType: "greenhouse", regex: /(?:boards|job-boards)\.greenhouse\.io\/([a-z0-9-]+)/i, extractId: (m) => m[1] },
  { atsType: "lever", regex: /jobs\.lever\.co\/([a-z0-9-]+)/i, extractId: (m) => m[1] },
  { atsType: "ashby", regex: /jobs\.ashbyhq\.com\/([a-z0-9-]+)/i, extractId: (m) => m[1] },
  { atsType: "smartrecruiters", regex: /jobs\.smartrecruiters\.com\/([a-zA-Z0-9-]+)/i, extractId: (m) => m[1] },
  {
    atsType: "workday",
    regex: /([a-z0-9-]+)\.wd\d\.myworkdayjobs\.com\/([a-zA-Z0-9-]+)/i,
    extractId: (m) => `${m[1]}/${m[2]}`,
  },
  { atsType: "icims", regex: /([a-z0-9-]+)\.icims\.com/i, extractId: (m) => m[1] },
  { atsType: "taleo", regex: /([a-z0-9-]+)\.taleo\.net/i, extractId: (m) => m[1] },
  { atsType: "successfactors", regex: /([a-z0-9-]+)\.(?:career\.)?successfactors\.com/i, extractId: (m) => m[1] },
];

export function detectAtsFromText(text: string): AtsDetectionResult {
  for (const p of PATTERNS) {
    const m = text.match(p.regex);
    if (m) return { atsType: p.atsType, atsIdentifier: p.extractId(m) };
  }
  return { atsType: "unknown", atsIdentifier: null };
}

// Fetches a company's careers page (following redirects) and checks both the
// final URL and the page body for a known ATS signature — covers both the
// "careers page redirects straight to the ATS" and "careers page embeds/links
// to the ATS" cases.
export async function detectAtsForCareersPage(careersUrl: string): Promise<AtsDetectionResult> {
  try {
    const res = await fetch(careersUrl, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(15_000),
    });
    const finalUrlResult = detectAtsFromText(res.url);
    if (finalUrlResult.atsType !== "unknown") return finalUrlResult;

    if (res.ok) {
      const body = await res.text();
      return detectAtsFromText(body);
    }
    return { atsType: "unknown", atsIdentifier: null };
  } catch {
    return { atsType: "unknown", atsIdentifier: null };
  }
}
