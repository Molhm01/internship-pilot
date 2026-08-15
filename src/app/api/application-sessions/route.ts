import { withUser } from "@/lib/auth/session";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { isCloudRuntime } from "@/lib/runtime/deployment";
import { readStoredObject } from "@/lib/storage";
import {
  OfficialApplicationUrlUnresolvedError,
  resolveOfficialApplicationDestination,
} from "@/lib/applications/officialDestination";

const inputSchema = z.object({
  company: z.string().min(1).max(200),
  jobTitle: z.string().min(1).max(300),
  url: z.string().url().max(2048),
  websiteJobId: z.string().min(1).max(200).optional(),
  location: z.string().max(200).optional(),
  eligibilityScore: z.number().min(0).max(1).optional(),
  tailoredResumeDocumentId: z.string().min(1).max(200),
  tailoredCoverLetterDocumentId: z.string().min(1).max(200).optional(),
  startAutofill: z.literal(false).default(false),
}).strict();

const agentEnvelopeSchema = z.object({ ok: z.literal(true), data: z.unknown() });
const agentErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    message: z.string(),
    debugContext: z.object({ fields: z.array(z.string()).optional() }).passthrough().optional(),
  }).passthrough(),
});
const sessionSchema = z.object({ id: z.string().min(1) });
const documentSchema = z.object({ id: z.string().min(1), tags: z.array(z.string()).default([]) });
const documentListSchema = z.object({ documents: z.array(documentSchema) });
const TOKEN_HEADER = "x-agent-token";

class RouteError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

function agentBaseUrl(): string {
  const configured = process.env.INTERNSHIP_AGENT_BASE_URL?.trim() || "http://127.0.0.1:4317";
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new RouteError("AGENT_BASE_URL_INVALID", 500);
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new RouteError("AGENT_BASE_URL_INVALID", 500);
  }
  // The agent deliberately binds IPv4 loopback. Normalizing localhost/::1
  // avoids Node choosing IPv6 first and intermittently receiving ECONNREFUSED.
  url.hostname = "127.0.0.1";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

async function agentRequest(
  baseUrl: string,
  token: string,
  pathname: string,
  init: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers: { "content-type": "application/json", [TOKEN_HEADER]: token, ...init.headers },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new RouteError("AGENT_SERVER_UNAVAILABLE", 503);
  }
  const raw = await response.json().catch(() => null);
  if (response.status === 401) throw new RouteError("AGENT_AUTH_FAILED", 502);
  if (!response.ok) {
    if (process.env.NODE_ENV === "development") {
      const failure = agentErrorEnvelopeSchema.safeParse(raw);
      console.warn("application-sessions: downstream validation failed", {
        status: response.status,
        issues: failure.success
          ? {
              paths: failure.data.error.debugContext?.fields ?? [],
              message: failure.data.error.message,
            }
          : { paths: [], message: "Unreadable Agent validation response" },
      });
    }
    throw new RouteError(response.status >= 500 ? "AGENT_SERVER_UNAVAILABLE" : "INVALID_PAYLOAD", response.status >= 500 ? 503 : 422);
  }
  const parsed = agentEnvelopeSchema.safeParse(raw);
  if (!parsed.success) throw new RouteError("AGENT_RESPONSE_INVALID", 502);
  return parsed.data.data;
}

async function transferDocuments(
  input: z.infer<typeof inputSchema>,
  baseUrl: string,
  token: string,
  userId: string,
): Promise<{ resumeId: string; coverLetterId?: string }> {
  if (!input.websiteJobId) {
    return {
      resumeId: input.tailoredResumeDocumentId,
      ...(input.tailoredCoverLetterDocumentId
        ? { coverLetterId: input.tailoredCoverLetterDocumentId }
        : {}),
    };
  }

  const requestedIds = [
    input.tailoredResumeDocumentId,
    ...(input.tailoredCoverLetterDocumentId ? [input.tailoredCoverLetterDocumentId] : []),
  ];
  const documents = await prisma.generatedDocument.findMany({
    where: {
      // Owner first. Document ids arrive in the request body, so without this
      // the route would hand another applicant's résumé to the local agent on
      // the strength of an id and a matching job.
      userId,
      id: { in: requestedIds },
      jobId: input.websiteJobId,
      qaStatus: "pass",
      identityVerified: true,
    },
  });
  if (!documents.some((document) => document.id === input.tailoredResumeDocumentId)) {
    throw new RouteError("INVALID_PAYLOAD", 422);
  }

  const listed = documentListSchema.parse(
    await agentRequest(baseUrl, token, "/documents", { method: "GET" }),
  );
  const result: { resumeId?: string; coverLetterId?: string } = {};

  for (const document of documents) {
    const marker = `internship-ai:${document.id}`;
    let agentId = listed.documents.find((candidate) => candidate.tags.includes(marker))?.id;
    if (!agentId) {
      const bytes = Buffer.from(await readStoredObject(document.storagePath));
      const type = document.type === "coverLetter" ? "cover_letter" : "resume";
      const uploaded = documentSchema.parse(
        await agentRequest(baseUrl, token, "/documents", {
          method: "POST",
          body: JSON.stringify({
            name: `${input.company} — ${input.jobTitle} — Tailored ${type === "resume" ? "Résumé" : "Cover Letter"}`,
            type,
            fileName: `${type}-${document.id}.pdf`,
            mimeType: "application/pdf",
            contentBase64: bytes.toString("base64"),
            tags: [marker, "tailored"],
            targetRoles: [input.jobTitle],
            targetIndustries: [],
            isDefault: false,
          }),
        }),
      );
      agentId = uploaded.id;
    }
    if (document.id === input.tailoredResumeDocumentId) result.resumeId = agentId;
    if (document.id === input.tailoredCoverLetterDocumentId) result.coverLetterId = agentId;
  }
  if (!result.resumeId) throw new RouteError("INVALID_PAYLOAD", 422);
  return { resumeId: result.resumeId, ...(result.coverLetterId ? { coverLetterId: result.coverLetterId } : {}) };
}

/**
 * Hands an application to the user's own local agent.
 *
 * The documents transferred are looked up against the signed-in user; the job
 * is shared, the résumé is not.
 */
export const POST = withUser(async (request, user) => {
  try {
    const body = await request.json().catch(() => null);
    const parsed = inputSchema.safeParse(body);
    if (!parsed.success) {
      if (process.env.NODE_ENV === "development") {
        console.warn("application-sessions: website input failed validation", {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join(".") || "(root)",
            message: issue.message,
          })),
        });
      }
      throw new RouteError("INVALID_PAYLOAD", 400);
    }
    // The agent listens on the user's own loopback interface. On a hosted
    // deployment `127.0.0.1` is this function's own container, so the request
    // would either hang or be refused, and the user would be told their agent
    // is broken when it is simply somewhere this server cannot reach. The
    // browser extension is the supported route from a deployed website.
    if (isCloudRuntime()) throw new RouteError("LOCAL_AGENT_NOT_REACHABLE_FROM_SERVER", 501);

    const input = parsed.data;
    const token = process.env.INTERNSHIP_AGENT_TOKEN?.trim();
    if (!token) throw new RouteError("AGENT_TOKEN_NOT_CONFIGURED", 503);
    const baseUrl = agentBaseUrl();

    const storedJob = input.websiteJobId
      ? await prisma.job.findUnique({
          where: { id: input.websiteJobId },
          select: { sourceUrl: true, officialApplyUrl: true, officialJobUrl: true, url: true },
        })
      : null;
    if (input.websiteJobId && !storedJob) throw new RouteError("INVALID_PAYLOAD", 400);

    const destination = await resolveOfficialApplicationDestination(
      storedJob ?? { officialApplyUrl: input.url },
    );
    const documentIds = await transferDocuments(input, baseUrl, token, user.id);
    const session = sessionSchema.parse(
      await agentRequest(baseUrl, token, "/application-sessions", {
        method: "POST",
        body: JSON.stringify({
          url: destination.officialApplicationUrl,
          company: input.company,
          jobTitle: input.jobTitle,
          websiteJobId: input.websiteJobId,
          location: input.location,
          eligibilityScore: input.eligibilityScore,
          tailoredResumeDocumentId: documentIds.resumeId,
          tailoredCoverLetterDocumentId: documentIds.coverLetterId,
          startAutofill: false,
        }),
      }),
    );

    console.info("application-sessions: created", {
      downstreamStatus: 201,
      headerName: TOKEN_HEADER,
      tokenConfigured: true,
    });
    return NextResponse.json({
      id: session.id,
      officialApplicationUrl: destination.officialApplicationUrl,
      sourceListingUrl: destination.sourceListingUrl,
    });
  } catch (error) {
    if (error instanceof OfficialApplicationUrlUnresolvedError) {
      return NextResponse.json({ error: error.code }, { status: 422 });
    }
    if (error instanceof RouteError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "INVALID_PAYLOAD" }, { status: 400 });
    }
    console.error("application-sessions: failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return NextResponse.json({ error: "SESSION_CREATION_FAILED" }, { status: 500 });
  }
});
