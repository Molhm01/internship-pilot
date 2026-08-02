import { prisma } from "@/lib/db";

export type JobMatchMethod = "requisition-id" | "ats-domain" | "company-name" | "job-title" | "thread-continuity" | "none";

export type JobMatchCandidate = {
  id: string;
  title: string;
  company: string;
  requisitionId: string | null;
  officialEmployerDomain: string | null;
};

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function extractDomain(address: string): string | null {
  const m = address.match(/@([a-z0-9.-]+)/i);
  return m ? m[1].toLowerCase() : null;
}

// Deterministic, no LLM involved — matching an email to the wrong job would
// mean silently updating the wrong application's tracker status, so this is
// pattern matching against known facts, never a guess.
export function matchEmailToJob(
  email: { subject: string; fromAddress: string; bodyText: string },
  candidates: JobMatchCandidate[],
): { job: JobMatchCandidate; method: JobMatchMethod } | null {
  const haystack = normalize(`${email.subject} ${email.bodyText}`);
  const fromDomain = extractDomain(email.fromAddress);

  for (const job of candidates) {
    if (job.requisitionId && job.requisitionId.length >= 4) {
      if (haystack.includes(normalize(job.requisitionId))) {
        return { job, method: "requisition-id" };
      }
    }
  }

  if (fromDomain) {
    for (const job of candidates) {
      if (job.officialEmployerDomain && fromDomain.endsWith(job.officialEmployerDomain.toLowerCase())) {
        return { job, method: "ats-domain" };
      }
    }
  }

  for (const job of candidates) {
    const companyNorm = normalize(job.company);
    if (companyNorm.length >= 3 && haystack.includes(companyNorm)) {
      // Company name alone matches many emails from the same employer — only
      // confidently resolve to a SINGLE job if this company has just one
      // candidate row, otherwise also require the title to line up.
      const sameCompanyCount = candidates.filter((c) => normalize(c.company) === companyNorm).length;
      if (sameCompanyCount === 1) return { job, method: "company-name" };
      const titleNorm = normalize(job.title);
      if (titleNorm.length >= 3 && haystack.includes(titleNorm)) {
        return { job, method: "job-title" };
      }
    }
  }

  return null;
}

export async function loadJobMatchCandidates(): Promise<JobMatchCandidate[]> {
  const jobs = await prisma.job.findMany({
    where: { status: { notIn: ["CLOSED", "REJECTED"] } },
    select: { id: true, title: true, company: true, requisitionId: true, officialEmployerDomain: true },
  });
  return jobs;
}
