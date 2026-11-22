import { NextResponse } from "next/server";
import { withUser } from "@/lib/auth/session";
import { extractBearerToken } from "@/lib/gmail/bearer";
import { getValidAccessToken } from "@/lib/gmail/account";
import { scanInboxForVerifications } from "@/lib/gmail/verificationCode";
import { syncGmailInbox } from "@/lib/gmail/sync";
import { verifyEmailLinkInChromium } from "@/lib/applications/remoteBrowserRunner";
import { retryPendingRuns } from "@/lib/applications/autonomousRunner";
import { readUserSetting, writeUserSetting } from "@/lib/userSettings";
import { logAudit } from "@/lib/applications/audit";

const VERIFIED_MESSAGE_IDS_KEY = "gmailVerifiedMessageIds";

export const POST = withUser(async (req, user) => {
  const bearerToken = extractBearerToken(req);
  const accessToken = bearerToken ?? (await getValidAccessToken(user.id).catch(() => null));

  if (!accessToken) {
    return NextResponse.json(
      { error: "Connect Gmail with 'Sign in with Google' first so the agent can read verification codes and links." },
      { status: 401 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const lookbackHours = typeof body?.lookbackHours === "number" ? body.lookbackHours : 72;
  const retryPending = body?.retryPending !== false;
  const retryLimit = typeof body?.limit === "number" ? body.limit : 12;

  try {
    const messages = await scanInboxForVerifications({
      accessToken,
      lookbackHours,
      maxMessages: 40,
    });

    const previouslyVerified = new Set<string>(
      await readUserSetting<string[]>(user.id, VERIFIED_MESSAGE_IDS_KEY, []),
    );

    const verifiedLinks: Array<{
      messageId: string;
      subject: string;
      fromAddress: string;
      url: string;
      verified: boolean;
      summary: string;
    }> = [];

    const codesFound: Array<{
      messageId: string;
      subject: string;
      fromAddress: string;
      code: string;
      receivedAt: string;
    }> = [];

    for (const msg of messages) {
      if (msg.code) {
        codesFound.push({
          messageId: msg.messageId,
          subject: msg.subject,
          fromAddress: msg.fromAddress,
          code: msg.code,
          receivedAt: msg.receivedAt,
        });
      }

      if (msg.links.length > 0 && !previouslyVerified.has(msg.messageId)) {
        const primaryUrl = msg.links[0];
        const result = await verifyEmailLinkInChromium(primaryUrl);
        verifiedLinks.push({
          messageId: msg.messageId,
          subject: msg.subject,
          fromAddress: msg.fromAddress,
          url: primaryUrl,
          verified: result.verified,
          summary: result.summary,
        });
        if (result.verified) {
          previouslyVerified.add(msg.messageId);
        }
      }
    }

    await writeUserSetting(
      user.id,
      VERIFIED_MESSAGE_IDS_KEY,
      Array.from(previouslyVerified).slice(-300),
    );

    // Also sync employer confirmations/assessments/interviews into the Tracker
    const inboxSync = await syncGmailInbox(user.id, accessToken).catch(() => ({
      checked: 0,
      classified: 0,
      newAssessments: 0,
      errors: 0,
      skipped: null,
    }));

    // Re-run pending applications in auto_submit mode with the live Gmail token so newly
    // verified accounts AND post-submit OTPs (Greenhouse/Microsoft/Workday) complete cleanly
    const retrySummary = retryPending
      ? await retryPendingRuns(user.id, { limit: retryLimit, gmailAccessToken: accessToken })
      : null;

    const linksVerifiedCount = verifiedLinks.filter((l) => l.verified).length;
    await logAudit({
      userId: user.id,
      actor: "gmail-tracking",
      action: "gmail-verifications-processed",
      detail: `Scanned ${messages.length} verification email(s): verified ${linksVerifiedCount} link(s), detected ${codesFound.length} OTP code(s)${retrySummary ? `, retried ${retrySummary.attempted} application(s) (${retrySummary.submitted} submitted)` : ""}.`,
      metadata: {
        messagesScanned: messages.length,
        linksAttempted: verifiedLinks.length,
        linksVerified: linksVerifiedCount,
        codesDetected: codesFound.length,
        retried: retrySummary?.attempted ?? 0,
        submitted: retrySummary?.submitted ?? 0,
      },
    }).catch(() => undefined);

    return NextResponse.json({
      messagesScanned: messages.length,
      linksAttempted: verifiedLinks.length,
      linksVerified: linksVerifiedCount,
      verifiedLinks,
      codesDetected: codesFound.length,
      codesFound: codesFound.slice(0, 10),
      inboxSync,
      retrySummary,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to verify Gmail codes and links.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
});
