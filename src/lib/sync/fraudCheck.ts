import { prisma } from "@/lib/db";

export type FraudSignal = { reason: string; detail: string };

const PERSONAL_EMAIL_DOMAINS = ["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "aol.com", "icloud.com"];

const PATTERNS: { reason: string; regex: RegExp; detail: string }[] = [
  {
    reason: "requests-payment",
    regex: /\b(application fee|processing fee|registration fee|pay (a |an )?(fee|deposit)|purchase (a |your )?(laptop|equipment|starter kit)|wire transfer|western union|moneygram)\b/i,
    detail: "Mentions a payment, fee, deposit, or required equipment purchase — legitimate internship applications never charge the candidate.",
  },
  {
    reason: "requests-cryptocurrency",
    regex: /\b(bitcoin|cryptocurrency|crypto wallet|usdt|ethereum payment)\b/i,
    detail: "Mentions cryptocurrency — never a normal part of a legitimate internship application.",
  },
  {
    reason: "requests-gift-cards",
    regex: /\bgift cards?\b/i,
    detail: "Mentions gift cards — a common scam payment method.",
  },
  {
    reason: "requests-banking-info",
    regex: /\b(bank account number|routing number|direct deposit (details|information) before)\b/i,
    detail: "Requests banking/direct-deposit details as part of the application itself, before any offer.",
  },
  {
    reason: "requests-government-id",
    regex: /\b(social security number|\bssn\b|passport number|driver'?s licen[sc]e number)\b/i,
    detail: "Requests a government ID number (SSN/passport/driver's license) during the normal application — that's normally collected during onboarding, not application.",
  },
  {
    reason: "unusual-contact-channel",
    regex: /\b(contact (us |me )?(on |via )?(telegram|whatsapp))\b/i,
    detail: "Directs the candidate to Telegram or WhatsApp instead of an official employer channel.",
  },
  {
    reason: "executable-download",
    regex: /https?:\/\/\S+\.(exe|scr|bat|msi|jar)\b/i,
    detail: "Contains a link to download an executable file.",
  },
];

export function isPersonalEmailDomain(address: string): boolean {
  const domain = address.split("@")[1]?.toLowerCase();
  return !!domain && PERSONAL_EMAIL_DOMAINS.some((d) => domain === d);
}

// The lazy `{0,60}?` prefix quantifier matters here: a greedy quantifier
// would consume into the email's local part and then backtrack only far
// enough to match a truncated SUFFIX of the address (e.g. "3@gmail.com"
// instead of "recruiter123@gmail.com"), since that partial string alone
// still satisfies the email pattern. Lazy expansion finds the earliest —
// and therefore complete — match instead.
const CONTACT_CONTEXT_PATTERN =
  /\b(?:contact|email|reach (?:us|out|me)|send (?:your )?(?:resume|application|cv) to)\b[^.\n]{0,60}?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;

function findPersonalContactEmails(text: string): string[] {
  const found: string[] = [];
  let match: RegExpExecArray | null;
  const pattern = new RegExp(CONTACT_CONTEXT_PATTERN.source, "gi");
  while ((match = pattern.exec(text))) {
    const email = match[1];
    if (isPersonalEmailDomain(email)) found.push(email);
  }
  return found;
}

export function scanTextForFraudSignals(text: string): FraudSignal[] {
  const signals: FraudSignal[] = [];
  for (const p of PATTERNS) {
    if (p.regex.test(text)) signals.push({ reason: p.reason, detail: p.detail });
  }
  const personalEmails = findPersonalContactEmails(text);
  if (personalEmails.length > 0) {
    signals.push({
      reason: "personal-email-contact",
      detail: `Directs applicants to contact a personal email address (${personalEmails.join(", ")}) instead of an official employer domain.`,
    });
  }
  return signals;
}

export async function quarantineJob(jobId: string, signals: FraudSignal[]): Promise<void> {
  await prisma.job.update({ where: { id: jobId }, data: { verificationStatus: "SecurityQuarantine" } });
  for (const s of signals) {
    await prisma.securityQuarantineEntry.create({
      data: { jobId, reason: s.reason, detail: s.detail, evidence: JSON.stringify({ signal: s }) },
    });
  }
}

// Scans a job's description (and, if available, the fully-rendered
// application page text) for fraud signals, and quarantines it if any are
// found — called both at verification time and immediately before the
// application agent ever touches a form, per the fraud-protection
// requirements ("never autofill or submit" to a flagged listing).
export async function checkJobForFraud(jobId: string, texts: string[]): Promise<FraudSignal[]> {
  const combined = texts.filter(Boolean).join("\n");
  const signals = scanTextForFraudSignals(combined);
  if (signals.length > 0) {
    await quarantineJob(jobId, signals);
  }
  return signals;
}
