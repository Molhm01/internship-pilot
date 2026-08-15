import { prisma } from "@/lib/db";

// Append-only. Never updated or deleted by application code — see
// AuditLogEntry in schema.prisma. Every automated decision anywhere in the
// app (matching, verification, document generation, the application agent,
// Gmail tracking) should call this so "why did the system do X" always has
// a real, timestamped answer.
export async function logAudit(entry: {
  /**
   * Whose activity this was.
   *
   * Set on anything a person did or that was done for them — an application, a
   * generated document, a match, a mailbox sync. Left null for global events
   * (discovery, verification of a posting), which belong to the installation
   * rather than to anybody. The audit-log API filters on it, so an entry that
   * describes one user's application and carries no owner would be readable by
   * every other user.
   */
  userId?: string | null;
  jobId?: string | null;
  actor: "ai-match" | "verification" | "document-generation" | "application-agent" | "gmail-tracking" | "user";
  action: string;
  detail: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await prisma.auditLogEntry.create({
    data: {
      userId: entry.userId ?? null,
      jobId: entry.jobId ?? null,
      actor: entry.actor,
      action: entry.action,
      detail: entry.detail,
      metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
    },
  });
}
