import { NextResponse } from "next/server";
import { withUser } from "@/lib/auth/session";
import { ensureStarterProfile, ensureWorkspaceBootstrapped, runLiveDiscoveryCycle } from "@/lib/bootstrap";
import {
  getAutopilotConfig,
  getAutopilotLastSummary,
  getPortalCredentials,
  retryPendingRuns,
  runAutopilotCycle,
  setAutopilotConfig,
  setPortalCredentials,
} from "@/lib/applications/autonomousRunner";
import { prisma } from "@/lib/db";
import { extractBearerToken } from "@/lib/gmail/bearer";

export const GET = withUser(async (_req, user) => {
  await ensureWorkspaceBootstrapped(user.id, { skipDiscovery: false });

  const [config, lastSummary, portalCredentials, gmailCount, activeJobs, scoredJobs, totalRuns, submittedRuns, filledRuns] =
    await Promise.all([
      getAutopilotConfig(user.id),
      getAutopilotLastSummary(user.id),
      getPortalCredentials(user.id),
      prisma.gmailAccount.count({ where: { userId: user.id } }),
      prisma.job.count({ where: { activeFeed: true } }),
      prisma.userJobState.count({ where: { userId: user.id, matchScore: { not: null } } }),
      prisma.applicationRun.count({ where: { userId: user.id } }),
      prisma.applicationRun.count({ where: { userId: user.id, status: "submitted" } }),
      prisma.applicationRun.count({ where: { userId: user.id, status: "filled" } }),
    ]);

  return NextResponse.json({
    config,
    lastSummary,
    portalCredentials,
    gmailConnected: gmailCount > 0,
    stats: {
      activeJobs,
      scoredJobs,
      totalRuns,
      submittedRuns,
      filledRuns,
      pausedRuns: 0,
    },
  });
});

export const POST = withUser(async (req, user) => {
  const body = await req.json().catch(() => ({}));
  const action = typeof body?.action === "string" ? body.action : "run_cycle";

  if (action === "update_credentials") {
    const portalCredentials = await setPortalCredentials(user.id, {
      ...(typeof body?.email === "string" ? { email: body.email } : {}),
      ...(typeof body?.password === "string" ? { password: body.password } : {}),
    });
    return NextResponse.json({ portalCredentials });
  }

  const partial = {
    ...(typeof body?.enabled === "boolean" ? { enabled: body.enabled } : {}),
    ...(body?.mode === "auto_submit" || body?.mode === "fill_to_submit" ? { mode: body.mode } : {}),
    ...(body?.minScore !== undefined ? { minScore: Number(body.minScore) } : {}),
    ...(body?.maxPerCycle !== undefined ? { maxPerCycle: Number(body.maxPerCycle) } : {}),
    ...(typeof body?.discoverFresh === "boolean" ? { discoverFresh: body.discoverFresh } : {}),
  };

  const config = Object.keys(partial).length > 0
    ? await setAutopilotConfig(user.id, partial)
    : await getAutopilotConfig(user.id);

  if (action === "update_config" || action === "toggle") {
    return NextResponse.json({ config, summary: await getAutopilotLastSummary(user.id) });
  }

  if (action === "discover") {
    await ensureStarterProfile(user.id);
    const result = await runLiveDiscoveryCycle({
      maxCompanies: 16,
      scoreUserId: user.id,
      maxScoreCount: 30,
    });
    return NextResponse.json({ config, discovery: result });
  }

  const gmailAccessToken = extractBearerToken(req);

  if (action === "retry_pending") {
    const limit = typeof body?.limit === "number" ? body.limit : 15;
    const summary = await retryPendingRuns(user.id, { limit, gmailAccessToken });
    return NextResponse.json({ config, summary });
  }

  const summary = await runAutopilotCycle(user.id, {
    mode: config.mode,
    minScore: config.minScore,
    maxApplications: config.maxPerCycle,
    discoverFresh: config.discoverFresh,
    gmailAccessToken,
  });

  return NextResponse.json({ config, summary });
});
