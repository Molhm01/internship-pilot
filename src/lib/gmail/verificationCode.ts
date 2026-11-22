import { getValidAccessToken } from "@/lib/gmail/account";
import { fetchMessage, listRecentMessageIds } from "@/lib/gmail/client";

export interface ExtractedVerificationEmail {
  code: string;
  subject: string;
  fromAddress: string;
  receivedAt: string;
  messageId?: string;
}

export interface ExtractedVerificationLinkEmail {
  url: string;
  allLinks: string[];
  subject: string;
  fromAddress: string;
  receivedAt: string;
  messageId: string;
}

export interface ScannedVerificationMessage {
  messageId: string;
  subject: string;
  fromAddress: string;
  receivedAt: string;
  code: string | null;
  links: string[];
}

const CODE_PATTERNS: RegExp[] = [
  /(?:security|verification|confirmation|one-time|passcode|otp)\s*(?:code|token|pin)?\s*(?:is|:)\s*([A-Za-z0-9]{4,10})\b/gi,
  /(?:security|verification|confirmation|one-time|passcode|otp)[^\n]{0,120}?(?:is|:)\s*([A-Za-z0-9]{6,10})\b/gi,
  /\benter\s+(?:the\s+)?(?:following\s+)?code\s*[:\s-]*([A-Za-z0-9]{4,10})\b/gi,
  /\b([0-9]{6,8})\b(?=\s*(?:is\s+your|to\s+verify|expires?\s+in))/gi,
  /\b([A-Za-z0-9]{8})\b(?=\s*(?:into\s+the\s+security\s+code|to\s+complete\s+your\s+application))/gi,
  // Standalone 6-8 char security code on its own line in Greenhouse/Microsoft verification emails
  /(?:^|\n)\s*([A-Z0-9a-z]{6,8})\s*(?:\n|$)/g,
];

const IGNORE_TOKENS = new Set([
  "YOUR",
  "CODE",
  "HERE",
  "THIS",
  "THAT",
  "WITH",
  "FROM",
  "EMAIL",
  "ENTER",
  "VERIFY",
  "SUBMIT",
  "THANK",
  "THANKS",
  "APPLY",
  "PLEASE",
  "INTO",
  "FIELD",
  "HTTPS",
  "HTTP",
]);

const VERIFICATION_CONTEXT_RE =
  /(?:verif|security\s*code|confirmation\s*code|one-time|passcode|otp|authenticate|activate\s+your\s+account|confirm\s+your\s+email|confirm\s+your\s+account|complete\s+your\s+registration)/i;

const ATS_SENDER_OR_SUBJECT_RE =
  /greenhouse|lever|ashby|workday|myworkday|icims|smartrecruiters|taleo|oraclecloud|eightfold|microsoft|rippling|bamboohr|jobvite|ultipro|brassring|successfactors|verif|security code|confirm your|activate your|application|careers|recruiting|talent/i;

const EXCLUDED_LINK_RE =
  /unsubscribe|opt-?out|privacy|terms|policy|preferences|manage-?email|facebook\.com|twitter\.com|x\.com|instagram\.com|youtube\.com|tiktok\.com|linkedin\.com\/company|mailto:|tel:|javascript:|\.(?:png|jpe?g|gif|svg|webp|ico|css|js)(?:[?#]|$)/i;

const STRONG_VERIFY_LINK_RE =
  /verif|confirm|activat|validat|email-?confirm|account-?confirm|magic-?link|signin|sign-?in|auth\/|token=|verification|code=|hash=|key=|myworkdayjobs\.com|greenhouse\.io|ashbyhq\.com|lever\.co|icims\.com|smartrecruiters\.com|oraclecloud\.com|eightfold\.ai|successfactors|taleo\.net/i;

function decodeHtmlEntities(raw: string): string {
  return raw
    .replace(/&amp;/gi, "&")
    .replace(/&#x3d;/gi, "=")
    .replace(/&#61;/gi, "=")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function cleanExtractedUrl(raw: string): string | null {
  const decoded = decodeHtmlEntities(raw.trim()).replace(/[.,;:!?)\]>'"]+$/, "");
  if (!/^https?:\/\//i.test(decoded)) return null;
  if (EXCLUDED_LINK_RE.test(decoded)) return null;
  try {
    const parsed = new URL(decoded);
    if (!parsed.hostname.includes(".")) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function scoreVerificationLink(url: string, anchorText = ""): number {
  let score = 0;
  const lowerUrl = url.toLowerCase();
  const lowerAnchor = anchorText.toLowerCase();

  if (/\b(verify|confirm|activate|complete registration|validate|continue application|verify email|confirm email)\b/i.test(lowerAnchor)) {
    score += 100;
  }
  if (/(?:verify|confirm|activate|validate|account[-_]?verify|email[-_]?verify|confirm[-_]?email)/i.test(lowerUrl)) {
    score += 70;
  }
  if (/[?&](?:token|code|key|hash|verification|signature|confirm|activation)=/i.test(lowerUrl)) {
    score += 55;
  }
  if (/(?:myworkdayjobs\.com|greenhouse\.io|ashbyhq\.com|lever\.co|icims\.com|smartrecruiters\.com|oraclecloud\.com|eightfold\.ai|successfactors|taleo\.net|careers\.microsoft\.com|account\.live\.com)/i.test(lowerUrl)) {
    score += 35;
  }
  // Deprioritize bare homepages with no path/query
  try {
    const parsed = new URL(url);
    if (parsed.pathname === "/" && !parsed.search) score -= 60;
  } catch {
    return -100;
  }
  return score;
}

/**
 * Extracts a portal email verification / security code (e.g., Greenhouse 8-character
 * alphanumeric token or Workday/Microsoft 6-digit OTP) from email content.
 */
export function extractVerificationCodeFromEmail(email: {
  subject: string;
  snippet?: string;
  bodyText: string;
}): string | null {
  const combined = `${email.subject}\n${email.bodyText || ""}\n${email.snippet || ""}`;
  if (!/(?:verif|security\s*code|confirmation\s*code|one-time|passcode|otp|authenticate)/i.test(combined)) {
    return null;
  }

  for (const pattern of CODE_PATTERNS) {
    for (const match of combined.matchAll(pattern)) {
      const candidate = match[1]?.trim();
      if (!candidate) continue;
      if (IGNORE_TOKENS.has(candidate.toUpperCase())) continue;
      if (/[0-9]/.test(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Extracts employer/ATS email verification & account activation links from HTML + plain text email bodies.
 */
export function extractVerificationLinksFromEmail(email: {
  subject: string;
  snippet?: string;
  bodyText: string;
  bodyHtml?: string;
}): string[] {
  const combinedText = `${email.subject}\n${email.bodyText || ""}\n${email.snippet || ""}`;
  if (!VERIFICATION_CONTEXT_RE.test(combinedText)) {
    return [];
  }

  const scored = new Map<string, number>();

  if (email.bodyHtml) {
    const anchorRe = /<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>/gi;
    for (const match of email.bodyHtml.matchAll(anchorRe)) {
      const rawHref = match[1] ?? match[2] ?? "";
      const anchorText = (match[3] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const cleaned = cleanExtractedUrl(rawHref);
      if (!cleaned) continue;
      const score = scoreVerificationLink(cleaned, anchorText);
      if (score >= 45 || (score >= 20 && STRONG_VERIFY_LINK_RE.test(cleaned))) {
        scored.set(cleaned, Math.max(scored.get(cleaned) ?? -Infinity, score));
      }
    }
  }

  const urlRe = /https?:\/\/[^\s<>"')]+/gi;
  for (const match of combinedText.matchAll(urlRe)) {
    const cleaned = cleanExtractedUrl(match[0]);
    if (!cleaned) continue;
    const score = scoreVerificationLink(cleaned);
    if (score >= 45 || (score >= 25 && STRONG_VERIFY_LINK_RE.test(cleaned))) {
      scored.set(cleaned, Math.max(scored.get(cleaned) ?? -Infinity, score));
    }
  }

  return Array.from(scored.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([url]) => url)
    .slice(0, 5);
}

async function resolveGmailToken(userId?: string, accessToken?: string | null): Promise<string | null> {
  if (accessToken && accessToken.trim().length >= 20) {
    return accessToken.trim();
  }
  if (userId) {
    return getValidAccessToken(userId).catch(() => null);
  }
  return null;
}

function matchesCompanyOrAts(
  msg: { subject: string; fromAddress: string; snippet: string },
  company?: string,
): boolean {
  const haystack = `${msg.subject} ${msg.fromAddress} ${msg.snippet}`.toLowerCase();
  const companyToken = (company ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)[0] ?? "";
  return ATS_SENDER_OR_SUBJECT_RE.test(haystack) || (companyToken.length >= 3 && haystack.includes(companyToken));
}

/**
 * Checks the user's connected Gmail inbox (via passed Bearer token or stored OAuth account)
 * for a fresh ATS verification/security code email received shortly before/after form submit.
 */
export async function waitForRecentVerificationCode(options: {
  userId?: string;
  accessToken?: string | null;
  company: string;
  sinceMs: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<ExtractedVerificationEmail | null> {
  const token = await resolveGmailToken(options.userId, options.accessToken);
  if (!token) return null;

  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  const pollMs = options.pollIntervalMs ?? 2_500;
  const afterEpoch = Math.max(0, Math.floor((options.sinceMs - 120_000) / 1000));

  while (Date.now() <= deadline) {
    try {
      const ids = await listRecentMessageIds(token, afterEpoch);
      for (const id of ids.slice(0, 10)) {
        const msg = await fetchMessage(token, id);
        if (msg.receivedAt.getTime() < options.sinceMs - 120_000) continue;
        if (!matchesCompanyOrAts(msg, options.company)) continue;

        const code = extractVerificationCodeFromEmail(msg);
        if (code) {
          return {
            code,
            subject: msg.subject,
            fromAddress: msg.fromAddress,
            receivedAt: msg.receivedAt.toISOString(),
            messageId: msg.gmailMessageId,
          };
        }
      }
    } catch {
      return null;
    }

    if (Date.now() + pollMs > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return null;
}

/**
 * Polls the user's connected Gmail inbox for a fresh ATS account/email verification link
 * (e.g., Workday, iCIMS, Oracle Cloud, SmartRecruiters account activation emails).
 */
export async function waitForRecentVerificationLink(options: {
  userId?: string;
  accessToken?: string | null;
  company: string;
  sinceMs: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<ExtractedVerificationLinkEmail | null> {
  const token = await resolveGmailToken(options.userId, options.accessToken);
  if (!token) return null;

  const deadline = Date.now() + (options.timeoutMs ?? 18_000);
  const pollMs = options.pollIntervalMs ?? 3_000;
  const afterEpoch = Math.max(0, Math.floor((options.sinceMs - 120_000) / 1000));

  while (Date.now() <= deadline) {
    try {
      const ids = await listRecentMessageIds(token, afterEpoch);
      for (const id of ids.slice(0, 10)) {
        const msg = await fetchMessage(token, id);
        if (msg.receivedAt.getTime() < options.sinceMs - 120_000) continue;
        if (!matchesCompanyOrAts(msg, options.company)) continue;

        const links = extractVerificationLinksFromEmail(msg);
        if (links.length > 0) {
          return {
            url: links[0],
            allLinks: links,
            subject: msg.subject,
            fromAddress: msg.fromAddress,
            receivedAt: msg.receivedAt.toISOString(),
            messageId: msg.gmailMessageId,
          };
        }
      }
    } catch {
      return null;
    }

    if (Date.now() + pollMs > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return null;
}

/**
 * Scans the user's Gmail inbox over the last N hours for all employer/ATS
 * verification emails containing confirmation/activation links or OTP codes.
 */
export async function scanInboxForVerifications(options: {
  accessToken: string;
  lookbackHours?: number;
  maxMessages?: number;
}): Promise<ScannedVerificationMessage[]> {
  const lookbackHours = Math.min(168, Math.max(1, options.lookbackHours ?? 72));
  const maxMessages = Math.min(60, Math.max(5, options.maxMessages ?? 40));
  const afterEpoch = Math.floor((Date.now() - lookbackHours * 60 * 60 * 1000) / 1000);

  const ids = await listRecentMessageIds(
    options.accessToken,
    afterEpoch,
    "(verify OR verification OR confirm OR activate OR \"security code\" OR passcode OR otp)",
  );

  const results: ScannedVerificationMessage[] = [];
  for (const id of ids.slice(0, maxMessages)) {
    try {
      const msg = await fetchMessage(options.accessToken, id);
      if (!matchesCompanyOrAts(msg)) continue;
      const code = extractVerificationCodeFromEmail(msg);
      const links = extractVerificationLinksFromEmail(msg);
      if (!code && links.length === 0) continue;
      results.push({
        messageId: msg.gmailMessageId,
        subject: msg.subject,
        fromAddress: msg.fromAddress,
        receivedAt: msg.receivedAt.toISOString(),
        code,
        links,
      });
    } catch {
      // Skip individual unreadable messages without failing the batch
    }
  }
  return results;
}
