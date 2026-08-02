import { prisma } from "@/lib/db";
import type { ReasonCode } from "@/lib/jobs/verificationModel";

/**
 * Record ONE verification attempt as an append-only row AND set the job's
 * CURRENT single clean reason. This is the only sanctioned way to write a
 * verification reason — it never reads the previous reason and never
 * concatenates, so the "POSTING_CLOSED: POSTING_CLOSED: ..." recursion can't
 * happen. Attempt history accumulates in VerificationAttempt, not in the
 * displayed string.
 */
export async function recordVerificationAttempt(input: {
  jobId: string;
  status: string;
  reasonCode: ReasonCode;
  message: string;
  httpStatus?: number | null;
}): Promise<void> {
  await prisma.verificationAttempt.create({
    data: {
      jobId: input.jobId,
      status: input.status,
      reasonCode: input.reasonCode,
      message: input.message,
      httpStatus: input.httpStatus ?? null,
    },
  });
}

/**
 * Strip any recursively-prepended "CODE: CODE: ..." prefixes from a legacy
 * reason string, leaving one clean message. Idempotent.
 */
export function stripRepeatedPrefixes(reason: string | null | undefined): string {
  if (!reason) return "";
  let out = reason;
  // Strip leading UPPER_SNAKE "CODE: " prefixes (one OR many), e.g.
  // "POSTING_CLOSED: POSTING_CLOSED: The page..." -> "The page..." and
  // "POSTING_CLOSED: Official page..." -> "Official page...". Only strips
  // while a human sentence (containing lowercase letters) still remains, so a
  // reason that is *only* codes is never emptied. Idempotent.
  for (let i = 0; i < 50; i++) {
    const next = out.replace(/^[A-Z][A-Z0-9_]{2,}:\s+/, "");
    if (next === out || !/[a-z]/.test(next)) break;
    out = next;
  }
  return out.trim();
}
