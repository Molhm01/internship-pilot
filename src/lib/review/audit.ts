import { prisma } from "@/lib/db";
import { csvFileExists } from "@/lib/employers/csv";
import { recomputeJobActiveFeed } from "@/lib/jobs/activeFeed";
import { stripRepeatedPrefixes } from "@/lib/jobs/verificationAttempt";

export const REVIEW_REASON_CODES = ["EMPLOYER_NOT_APPROVED","OFFICIAL_JOB_NOT_FOUND","ATS_TENANT_NOT_PROVEN","POSTING_CLOSED","JOB_ID_MISMATCH","COMPANY_MISMATCH","LOCATION_MISMATCH","NETWORK_FAILURE","PARSING_FAILURE","STALE_VERIFICATION","DEMO_OR_FIXTURE","MISSING_EVIDENCE"] as const;
export type ReviewReasonCode = typeof REVIEW_REASON_CODES[number];

const DEMO = /(?:mock ats test|test documents co|test sync|fixture|demo company)/i;

export function classifyReviewReason(job: { company: string; source: string | null; verificationStatus: string; verificationReason: string | null; url: string | null; evidence: string | null; lastVerifiedAt: Date | null }, approvedEmployer: boolean, sourceAvailable: boolean): ReviewReasonCode {
  const reason = job.verificationReason ?? "";
  if (DEMO.test(job.company) || /fixture|mock test/i.test(reason)) return "DEMO_OR_FIXTURE";
  if (job.verificationStatus === "Closed" || /closed|no longer open|404/i.test(reason)) return "POSTING_CLOSED";
  if (!sourceAvailable) return "MISSING_EVIDENCE";
  if (!approvedEmployer) return "EMPLOYER_NOT_APPROVED";
  if (/location/i.test(reason) && /doesn.t match|mismatch/i.test(reason)) return "LOCATION_MISMATCH";
  if (/company/i.test(reason) && /doesn.t match|mismatch/i.test(reason)) return "COMPANY_MISMATCH";
  if (/job id|requisition/i.test(reason) && /mismatch/i.test(reason)) return "JOB_ID_MISMATCH";
  if (/network|timed out|could not reach|fetch/i.test(reason)) return "NETWORK_FAILURE";
  if (/parse|malformed|invalid html/i.test(reason)) return "PARSING_FAILURE";
  if (job.lastVerifiedAt && Date.now() - job.lastVerifiedAt.getTime() > 24 * 60 * 60 * 1000) return "STALE_VERIFICATION";
  if (!job.url || /could not independently locate|not found/i.test(reason)) return "OFFICIAL_JOB_NOT_FOUND";
  if (!job.evidence) return "MISSING_EVIDENCE";
  return "ATS_TENANT_NOT_PROVEN";
}

export async function getNeedsReviewAudit() {
  const sourceAvailable = await csvFileExists();
  const [jobs, companies] = await Promise.all([
    // Needs Review = jobs NOT in the Active feed and not officially verified.
    // Trusted-aggregator listings (now activeFeed=true) are intentionally
    // excluded here even while their official destination is unverified.
    prisma.job.findMany({ where: { activeFeed: false, verificationStatus: { in: ["Pending", "NeedsReview", "CLOSED_OR_UNVERIFIED", "Closed", "Unverified"] } }, orderBy: { createdAt: "desc" } }),
    prisma.company.findMany({ where: { allowlisted: true }, select: { name: true, source: true } }),
  ]);
  const approved = new Set(companies.filter((company) => company.source === "csv" || company.source === "manual" || company.source === "intern-list-approved").map((company) => company.name.trim().toLocaleLowerCase()));
  const records = jobs.map((job) => ({ ...job, reasonCode: classifyReviewReason(job, approved.has(job.company.trim().toLocaleLowerCase()), sourceAvailable), excludedFromProduction: DEMO.test(job.company) }));
  const counts = Object.fromEntries(REVIEW_REASON_CODES.map((code) => [code, records.filter((record) => record.reasonCode === code).length]));
  return { sourceAvailable, total: records.length, counts, records };
}

// Read-only diagnostic refresh. This function no longer mutates
// verificationStatus and NEVER prepends a reason code onto the existing
// reason (that recursion is what produced "POSTING_CLOSED: POSTING_CLOSED:
// ..."). It only strips any legacy repeated prefixes to leave one clean
// message, and recomputes the central Active-feed flag so visibility stays
// consistent. A missing ATS mirror is never turned into "Closed" here.
export async function refreshNeedsReviewAudit() {
  const audit = await getNeedsReviewAudit();
  const checkedAt = new Date();
  for (const record of audit.records) {
    const cleaned = stripRepeatedPrefixes(record.verificationReason);
    if (cleaned !== (record.verificationReason ?? "")) {
      await prisma.job.update({ where: { id: record.id }, data: { verificationReason: cleaned || record.verificationReason } });
    }
    await recomputeJobActiveFeed(record.id);
  }
  await prisma.appSetting.upsert({ where: { key: "needsReviewAudit" }, update: { value: JSON.stringify({ attempted: audit.total, checkedAt: checkedAt.toISOString(), sourceAvailable: audit.sourceAvailable, counts: audit.counts }) }, create: { key: "needsReviewAudit", value: JSON.stringify({ attempted: audit.total, checkedAt: checkedAt.toISOString(), sourceAvailable: audit.sourceAvailable, counts: audit.counts }) } });
  return getNeedsReviewAudit();
}
