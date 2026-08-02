import { z } from "zod";

// Schema for the local agent session creation input
const createApplicationSessionInput = z.object({
  company: z.string().min(1),
  jobTitle: z.string().min(1),
  url: z.string().url(),
  websiteJobId: z.string().optional(),
  location: z.string().optional(),
  eligibilityScore: z.number().min(0).max(1).optional(),
  tailoredResumeDocumentId: z.string().min(1),
  tailoredCoverLetterDocumentId: z.string().optional(),
  startAutofill: z.boolean().default(false),
}).strict();

// Schema for the local agent session response
const createApplicationSessionResponse = z.object({
  id: z.string().min(1),
  officialApplicationUrl: z.string().url(),
  sourceListingUrl: z.string().url().nullable(),
});

export type CreateApplicationSessionInput = z.infer<typeof createApplicationSessionInput>;
export type CreateApplicationSessionResponse = z.infer<typeof createApplicationSessionResponse>;

// Error types
export class LocalAgentError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = "LocalAgentError";
  }
}

/**
 * Browser-safe client to create application sessions via server route.
 * This version does NOT import Prisma or any server-only modules.
 */
export async function createApplicationSession(input: CreateApplicationSessionInput): Promise<CreateApplicationSessionResponse> {
  const parsedInput = createApplicationSessionInput.safeParse(input);
  if (!parsedInput.success) {
    throw new LocalAgentError("INVALID_PAYLOAD", "INVALID_PAYLOAD");
  }
  // Call the server-side API endpoint
  const response = await fetch("/api/application-sessions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(parsedInput.data),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const message = errorData.error || `HTTP ${response.status}`;
    
    const knownCode =
      response.status >= 500 &&
      ![
        "AGENT_TOKEN_NOT_CONFIGURED",
        "AGENT_AUTH_FAILED",
        "AGENT_SERVER_UNAVAILABLE",
        "AGENT_BASE_URL_INVALID",
      ].includes(message)
        ? "AGENT_SERVER_UNAVAILABLE"
        : typeof message === "string"
          ? message
          : "SESSION_CREATION_FAILED";
    throw new LocalAgentError(knownCode, knownCode);
  }

  const responseBody = await response.json();
  return createApplicationSessionResponse.parse(responseBody);
}
