export type AtsDetectionResult = { atsType: string; atsIdentifier: string | null };

type Pattern = { atsType: string; regex: RegExp; extractId: (m: RegExpMatchArray) => string };

const PATTERNS: Pattern[] = [
  // Greenhouse's legacy embed URL puts the real tenant in ?for=. Matching the
  // path alone used to persist the meaningless slug "embed" for every board.
  { atsType: "greenhouse", regex: /boards\.greenhouse\.io\/embed\/job_board\/js\?[^"'\s>]*\bfor=([a-z0-9_-]+)/i, extractId: (m) => m[1] },
  { atsType: "greenhouse", regex: /(?:boards|job-boards)\.greenhouse\.io\/(?!embed(?:[/?#]|$))([a-z0-9_-]+)/i, extractId: (m) => m[1] },
  // Workable job links are apply.workable.com/j/<shortcode>; the ACCOUNT form
  // is apply.workable.com/<account>. Excluding the literal "j" segment keeps a
  // posting link from being read as the tenant.
  { atsType: "workable", regex: /apply\.workable\.com\/(?!j\/)([a-z0-9][a-z0-9-]{1,60})/i, extractId: (m) => m[1] },
  { atsType: "lever", regex: /jobs\.lever\.co\/([a-z0-9-]+)/i, extractId: (m) => m[1] },
  { atsType: "ashby", regex: /jobs\.ashbyhq\.com\/([a-z0-9-]+)/i, extractId: (m) => m[1] },
  { atsType: "smartrecruiters", regex: /jobs\.smartrecruiters\.com\/([a-zA-Z0-9-]+)/i, extractId: (m) => m[1] },
  {
    atsType: "workday",
    // Keep the Workday shard in the identifier. Older rows stored
    // `tenant/site`; newer detections store `tenant.wdN/site`. The adapter
    // supports both, which avoids silently routing a wd5/wd12 tenant to wd1.
    //
    // Two details matter for real employer links:
    //  - Many Workday sites are served under a locale segment
    //    (".../en-US/hubbell_careers/..."). Reading "en-US" as the site name
    //    made every such tenant resolve to a career site that does not exist,
    //    so a leading locale is skipped.
    //  - Site names commonly contain underscores ("hubbell_careers"), which the
    //    previous character class truncated.
    regex:
      /([a-z0-9-]+\.wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}[-_][a-z]{2}\/)?([a-zA-Z0-9_-]+)/i,
    extractId: (m) => `${m[1]}/${m[2]}`,
  },
  { atsType: "icims", regex: /([a-z0-9-]+)\.icims\.com/i, extractId: (m) => m[1] },
  { atsType: "taleo", regex: /([a-z0-9-]+)\.taleo\.net/i, extractId: (m) => m[1] },
  {
    atsType: "successfactors",
    // SuccessFactors public career hosts are deployed across .com and .eu
    // shards (for example career5.successfactors.eu). The structured adapter
    // uses the actual careersUrl, so this identifier is evidence/tenant context
    // rather than a URL-construction token.
    regex: /([a-z0-9-]+)\.(?:career\.)?successfactors\.(?:com|eu)/i,
    extractId: (m) => m[1],
  },
];

export function detectAtsFromText(text: string): AtsDetectionResult {
  for (const p of PATTERNS) {
    const m = text.match(p.regex);
    if (m) return { atsType: p.atsType, atsIdentifier: p.extractId(m) };
  }
  return { atsType: "unknown", atsIdentifier: null };
}

// ---------------------------------------------------------------------------
// Client-rendered career-site vendors
// ---------------------------------------------------------------------------
//
// Eightfold and Phenom do not put a recognisable board URL anywhere in the
// page — they render everything from JSON at runtime and serve their API from
// the EMPLOYER's own hostname. So detection needs two things the URL-pattern
// table above cannot express: the page body (for the tenant key) and the page's
// final URL (for the host that serves the API). Their identifiers are stored as
// "<careersHost>|<tenantKey>".

/** `window._EF_GROUP_ID = "globalfoundries.com"` on every Eightfold PCSX site. */
const EIGHTFOLD_GROUP_ID = /window\._EF_GROUP_ID\s*=\s*["']([^"']+)["']/i;
const EIGHTFOLD_MARKER = /app\.eightfold\.ai|static\.vscdn\.net|_EF_PRODUCT\s*=\s*["']PCS/i;

/** Phenom publishes its tenant as `refNum`, and again in its CDN asset paths. */
const PHENOM_REF_NUM = [
  /["']refNum["']\s*:\s*["']([A-Z0-9_]{4,40})["']/,
  /CareerConnectResources\/([A-Z0-9_]{4,40})\//,
  /["']ph_?id["']\s*[:=]\s*["']([A-Z0-9_]{4,40})["']/i,
] as const;
const PHENOM_MARKER = /phenompeople\.com|cdn-bot\.phenompeople|content-ir\.phenompeople/i;

/**
 * Identify a client-rendered career-site vendor from a fetched page.
 *
 * `finalUrl` must be the URL the page was actually served from after redirects,
 * because that host — not the vendor's — is where the public JSON API lives.
 */
export function detectClientRenderedAts(html: string, finalUrl: string): AtsDetectionResult {
  let host: string;
  try {
    host = new URL(finalUrl).hostname.toLowerCase();
  } catch {
    return { atsType: "unknown", atsIdentifier: null };
  }

  if (EIGHTFOLD_MARKER.test(html)) {
    const groupId = html.match(EIGHTFOLD_GROUP_ID)?.[1]?.trim();
    if (groupId) return { atsType: "eightfold", atsIdentifier: `${host}|${groupId}` };
  }

  if (PHENOM_MARKER.test(html)) {
    for (const pattern of PHENOM_REF_NUM) {
      const refNum = html.match(pattern)?.[1]?.trim();
      if (refNum) return { atsType: "phenom", atsIdentifier: `${host}|${refNum}` };
    }
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
      const linked = detectAtsFromText(body);
      if (linked.atsType !== "unknown") return linked;
      // Nothing on the page links to a classic board. Before giving up, check
      // whether the page IS a client-rendered career site whose postings live
      // behind a JSON API on this same host.
      return detectClientRenderedAts(body, res.url || careersUrl);
    }
    return { atsType: "unknown", atsIdentifier: null };
  } catch {
    return { atsType: "unknown", atsIdentifier: null };
  }
}
