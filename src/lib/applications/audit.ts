import { prisma } from "@/lib/db";

// Append-only. Never updated or deleted by application code — see
// AuditLogEntry in schema.prisma. Every automated decision anywhere in the
// app (matching, verification, document generation, the application agent,
// Gmail tracking) should call this so "why did the system do X" always has
// a real, timestamped answer.
export async function logAudit(entry: {
  jobId?: string | null;
  actor: "ai-match" | "verification" | "document-generation" | "application-agent" | "gmail-tracking" | "user";
  action: string;
  detail: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await prisma.auditLogEntry.create({
    data: {
      jobId: entry.jobId ?? null,
      actor: entry.actor,
      action: entry.action,
      detail: entry.detail,
      metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
    },
  });
}
