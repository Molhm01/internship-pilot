import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { recheckOfficialUrl, verifyJob } from "@/lib/sync/verify";
import { logAudit } from "@/lib/applications/audit";
import { checkJobForFraud } from "@/lib/sync/fraudCheck";
import { recomputeJobActiveFeed } from "@/lib/jobs/activeFeed";
import { recordVerificationAttempt } from "@/lib/jobs/verificationAttempt";
import {
  destinationPersistenceData,
  resolveOfficialJobDestination,
} from "@/lib/applications/officialDestination";

// Re-checks a single job on demand — used right before the user would apply,
// per "recheck the official page immediately before any future application".
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await prisma.job.findUnique({ where: { id } });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const currentOfficialUrl =
    job.officialApplicationUrl ?? job.officialApplyUrl ?? job.url;
  if (job.verificationStatus === "VERIFIED_OFFICIAL_AT_LAST_CHECK" && currentOfficialUrl) {
    const { availability, reasonCode, reason, redirectChain, httpStatus } =
      await recheckOfficialUrl(currentOfficialUrl);
    // Only a genuine 404/410 closes the job; a transient failure holds it as
    // verified rather than falsely closing it.
    const closing = availability === "closed";
    const destination = await resolveOfficialJobDestination(job);
    const updated = await prisma.job.update({
      where: { id },
      data: {
        lastVerifiedAt: new Date(),
        ...destinationPersistenceData(destination),
        reasonCode,
        verificationReason: reason,
        redirectChain: JSON.stringify(redirectChain),
        httpStatusAtVerification: httpStatus,
        ...(closing ? { verificationStatus: "Closed" } : {}),
      },
    });
    await recordVerificationAttempt({ jobId: id, status: closing ? "Closed" : job.verificationStatus, reasonCode, message: reason, httpStatus });
    await recomputeJobActiveFeed(id);
    await logAudit({
      jobId: id,
      actor: "verification",
      action: "reverify-checked",
      detail: reason,
      metadata: { availability },
    });
    return NextResponse.json({ job: updated });
  }

  const result = await verifyJob({
    title: job.title,
    company: job.company,
    location: job.location,
    workModel: job.workplaceType,
  });
  const company = await prisma.company.findFirst({
    where: { name: { equals: job.company } },
    select: { careersUrl: true },
  });
  const destination = await resolveOfficialJobDestination({
    ...job,
    verificationStatus: result.status,
    officialApplicationUrl: result.officialApplyUrl ?? job.officialApplicationUrl,
    officialApplyUrl: result.officialApplyUrl ?? job.officialApplyUrl,
    officialJobUrl: result.officialApplyUrl ?? job.officialJobUrl,
    url: result.officialApplyUrl ?? job.url,
    employerCareerUrl: company?.careersUrl,
  });

  const updated = await prisma.job.update({
    where: { id },
    data: {
      verificationStatus: result.status,
      reasonCode: result.reasonCode,
      verificationReason: result.reason,
      verificationMethod: result.verificationMethod ?? null,
      officialEmployerDomain: result.officialEmployerDomain ?? null,
      evidence: result.evidence ? JSON.stringify(result.evidence) : null,
      lastVerifiedAt: new Date(),
      atsTenant: result.atsTenant ?? null,
      ...destinationPersistenceData(destination),
      redirectChain: result.redirectChain ? JSON.stringify(result.redirectChain) : null,
      httpStatusAtVerification: result.httpStatusAtVerification ?? null,
      ...(result.requisitionId ? { requisitionId: result.requisitionId } : {}),
      ...(result.officialDescription ? { description: result.officialDescription } : {}),
    },
  });
  await recordVerificationAttempt({
    jobId: id,
    status: result.status,
    reasonCode: result.reasonCode,
    message: result.reason,
    httpStatus: result.httpStatusAtVerification ?? null,
  });
  await recomputeJobActiveFeed(id);

  await logAudit({
    jobId: id,
    actor: "verification",
    action: "verification-result",
    detail: `${result.status}: ${result.reason}`,
    metadata: { verificationMethod: result.verificationMethod, evidence: result.evidence },
  });

  if (result.officialDescription) {
    const signals = await checkJobForFraud(id, [result.officialDescription]);
    if (signals.length > 0) {
      await logAudit({
        jobId: id,
        actor: "verification",
        action: "security-quarantine",
        detail: `Moved to Security Quarantine: ${signals.map((s) => s.reason).join(", ")}`,
      });
      await recomputeJobActiveFeed(id);
      const quarantined = await prisma.job.findUnique({ where: { id } });
      return NextResponse.json({ job: quarantined });
    }
  }

  return NextResponse.json({ job: updated });
}
