/**
 * Document asset integrity.
 *
 * HTTP 200 on a health endpoint says a Node process is alive. It says nothing
 * about whether the page that process serves can actually render: a Next
 * server whose `.next` directory was deleted underneath it still answers a
 * route handler, still returns a full HTML document, and still 404s or 500s
 * every `_next/static` chunk and stylesheet that document references. What the
 * user sees is unstyled HTML with browser-default links and an unbounded logo.
 *
 * So "healthy" is redefined here as: the document renders AND every same-origin
 * asset it depends on can be fetched. The parsing is deliberately a small
 * regex pass rather than a DOM library — the launcher must be able to run this
 * before anything is installed, and the shapes Next emits are narrow.
 */

export type DocumentAssetKind = "script" | "stylesheet" | "preload" | "module";

export type DocumentAsset = {
  url: string;
  kind: DocumentAssetKind;
  /** True for `_next/static/...`, which is always build-output. */
  buildOutput: boolean;
};

export type AssetProbeResult = DocumentAsset & {
  status: number | null;
  error?: string;
};

export type AssetHealthReport = {
  ok: boolean;
  documentStatus: number | null;
  documentBytes: number;
  checked: number;
  failures: AssetProbeResult[];
  /** Assets that exist but that the document referenced zero of — a red flag. */
  reason:
    | "ok"
    | "document_unreachable"
    | "document_error_status"
    | "no_assets_referenced"
    | "asset_failures";
  detail: string;
};

const TAG_PATTERN = /<(script|link)\b[^>]*>/gi;
const ATTR_PATTERN = /([a-z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

function attributesOf(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_PATTERN.exec(tag)) !== null) {
    const name = match[1]!.toLowerCase();
    attrs[name] = match[3] ?? match[4] ?? match[5] ?? "";
  }
  return attrs;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

/**
 * Every same-origin script/stylesheet the document depends on, de-duplicated
 * and absolutized. Cross-origin resources are intentionally excluded: a font
 * CDN being slow is not a reason to restart the user's local server.
 */
export function extractDocumentAssets(html: string, baseUrl: string): DocumentAsset[] {
  const origin = new URL(baseUrl).origin;
  const seen = new Map<string, DocumentAsset>();

  TAG_PATTERN.lastIndex = 0;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = TAG_PATTERN.exec(html)) !== null) {
    const tagName = tagMatch[1]!.toLowerCase();
    const attrs = attributesOf(tagMatch[0]);

    let raw: string | undefined;
    let kind: DocumentAssetKind;

    if (tagName === "script") {
      raw = attrs.src;
      kind = attrs.type === "module" ? "module" : "script";
    } else {
      const rel = (attrs.rel ?? "").toLowerCase();
      if (rel.split(/\s+/).includes("stylesheet")) kind = "stylesheet";
      else if (rel === "preload" && (attrs.as === "script" || attrs.as === "style")) kind = "preload";
      else continue;
      raw = attrs.href;
    }

    if (!raw) continue;
    let absolute: URL;
    try {
      absolute = new URL(decodeEntities(raw), baseUrl);
    } catch {
      continue;
    }
    if (absolute.origin !== origin) continue;
    if (absolute.protocol !== "http:" && absolute.protocol !== "https:") continue;

    const key = absolute.toString();
    if (seen.has(key)) continue;
    seen.set(key, {
      url: key,
      kind,
      buildOutput: absolute.pathname.startsWith("/_next/static/"),
    });
  }

  return [...seen.values()];
}

/** A response status that means the asset is genuinely broken. */
export function isAssetFailureStatus(status: number | null): boolean {
  if (status === null) return true;
  return status === 404 || status >= 500;
}

export function summarizeAssetHealth(input: {
  documentStatus: number | null;
  documentBytes: number;
  probes: AssetProbeResult[];
  /** Some documents legitimately reference nothing; the caller decides. */
  requireAssets: boolean;
}): AssetHealthReport {
  const { documentStatus, documentBytes, probes, requireAssets } = input;

  if (documentStatus === null) {
    return {
      ok: false,
      documentStatus,
      documentBytes,
      checked: 0,
      failures: [],
      reason: "document_unreachable",
      detail: "The document route could not be fetched at all.",
    };
  }
  if (documentStatus >= 400) {
    return {
      ok: false,
      documentStatus,
      documentBytes,
      checked: 0,
      failures: [],
      reason: "document_error_status",
      detail: `The document route returned HTTP ${documentStatus}.`,
    };
  }

  if (requireAssets && probes.length === 0) {
    return {
      ok: false,
      documentStatus,
      documentBytes,
      checked: 0,
      failures: [],
      reason: "no_assets_referenced",
      detail:
        "The document referenced no same-origin script or stylesheet at all, which means it was not rendered by a working Next build.",
    };
  }

  const failures = probes.filter((probe) => isAssetFailureStatus(probe.status));
  if (failures.length > 0) {
    const sample = failures
      .slice(0, 4)
      .map((failure) => `${failure.status ?? "no response"} ${failure.kind} ${failure.url}`)
      .join("; ");
    return {
      ok: false,
      documentStatus,
      documentBytes,
      checked: probes.length,
      failures,
      reason: "asset_failures",
      detail: `${failures.length} of ${probes.length} referenced assets failed to load: ${sample}`,
    };
  }

  return {
    ok: true,
    documentStatus,
    documentBytes,
    checked: probes.length,
    failures: [],
    reason: "ok",
    detail: `Document and all ${probes.length} referenced same-origin assets loaded.`,
  };
}
