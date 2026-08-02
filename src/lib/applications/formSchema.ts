import { z } from "zod";
import { EXTENSION_PROTOCOL_VERSION, SERVER_BUILD } from "./extensionProtocol";
import { detectAtsFromText } from "@/lib/ats/detect";

export const FORM_SCHEMA_VERSION = 1;

export const blockerSchema = z
  .object({
    kind: z.enum(["captcha", "mfa", "login", "signature", "legal", "assessment"]),
    detail: z.string().max(4_000).default(""),
  })
  .passthrough();

export const extensionFieldSchema = z
  .object({
    index: z.number().int().min(0).max(1_000),
    label: z.string().max(4_000).optional().default(""),
    groupLabel: z.string().max(4_000).optional().default(""),
    optionLabel: z.string().max(2_000).optional().default(""),
    name: z.string().max(2_000).optional().default(""),
    id: z.string().max(2_000).optional().default(""),
    ariaLabel: z.string().max(4_000).optional().default(""),
    placeholder: z.string().max(4_000).optional().default(""),
    nearbyText: z.string().max(20_000).optional().default(""),
    role: z.string().max(500).optional().default(""),
    type: z.string().max(200).optional().default("text"),
    required: z.boolean().optional().default(false),
    options: z.array(z.string().max(2_000)).max(1_000).optional().default([]),
    currentValue: z.string().max(50_000).optional().default(""),
  })
  .passthrough();

export const extensionFillPlanRequestSchema = z
  .object({
    runId: z.string().min(1).max(200).nullable().optional(),
    pageUrl: z.string().url(),
    pageTitle: z.string().max(4_000).optional().default(""),
    fields: z.array(extensionFieldSchema).min(1).max(1_000),
    blockers: z.array(blockerSchema).max(50).optional().default([]),
    protocolVersion: z.number().int().optional().default(EXTENSION_PROTOCOL_VERSION),
    schemaVersion: z.number().int().optional().default(FORM_SCHEMA_VERSION),
  })
  .passthrough();

export type ExtensionField = z.infer<typeof extensionFieldSchema>;
export type FillPlanRequest = z.infer<typeof extensionFillPlanRequestSchema>;

export interface FormValidationDiagnostic {
  errorCode: string;
  validationPath: string | null;
  message: string;
  sanitizedLog: Record<string, unknown>;
}

export function validateFormDescriptionPayload(body: unknown, requestHeaders?: Headers): {
  success: true;
  data: FillPlanRequest;
} | {
  success: false;
  diagnostic: FormValidationDiagnostic;
} {
  if (!body || typeof body !== "object") {
    const diagnostic: FormValidationDiagnostic = {
      errorCode: "FORM_DESCRIPTION_INVALID",
      validationPath: "root",
      message: "FORM_DESCRIPTION_INVALID: request body expected object but received null or non-object",
      sanitizedLog: {
        protocolVersion: EXTENSION_PROTOCOL_VERSION,
        serverBuildVersion: SERVER_BUILD,
        topLevelKeys: [],
        fieldCount: 0,
        receivedType: typeof body,
      },
    };
    return { success: false, diagnostic };
  }

  const raw = body as Record<string, unknown>;
  const reqProtocolVersion = typeof raw.protocolVersion === "number" ? raw.protocolVersion : undefined;
  if (reqProtocolVersion !== undefined && reqProtocolVersion !== EXTENSION_PROTOCOL_VERSION) {
    const message = `FORM_DESCRIPTION_VERSION_MISMATCH: extension protocol ${reqProtocolVersion}, server protocol ${EXTENSION_PROTOCOL_VERSION}`;
    const diagnostic: FormValidationDiagnostic = {
      errorCode: "FORM_DESCRIPTION_VERSION_MISMATCH",
      validationPath: "protocolVersion",
      message,
      sanitizedLog: {
        protocolVersion: reqProtocolVersion,
        serverProtocolVersion: EXTENSION_PROTOCOL_VERSION,
        serverBuildVersion: SERVER_BUILD,
        pageUrl: typeof raw.pageUrl === "string" ? raw.pageUrl : "unknown",
      },
    };
    return { success: false, diagnostic };
  }

  const parsed = extensionFillPlanRequestSchema.safeParse(body);
  if (parsed.success) {
    return { success: true, data: parsed.data };
  }

  const firstIssue = parsed.error.issues[0];
  const pathString = firstIssue ? firstIssue.path.join(".") : "root";
  const expected = firstIssue && "expected" in firstIssue ? String(firstIssue.expected) : undefined;
  const received = firstIssue && "received" in firstIssue ? String(firstIssue.received) : undefined;
  
  let detailedReason = firstIssue ? firstIssue.message : "Validation failed";
  if (expected && received) {
    detailedReason = `${pathString || "field"} expected ${expected} but received ${received}`;
  } else if (pathString) {
    detailedReason = `${pathString}: ${firstIssue.message}`;
  }

  const message = `FORM_DESCRIPTION_INVALID: ${detailedReason}`;

  const sanitizedLog = {
    protocolVersion: reqProtocolVersion ?? EXTENSION_PROTOCOL_VERSION,
    extensionBuildVersion: requestHeaders?.get("x-extension-version") ?? "unknown",
    serverBuildVersion: SERVER_BUILD,
    pageUrl: typeof raw.pageUrl === "string" ? raw.pageUrl : "unknown",
    atsType: typeof raw.pageUrl === "string" ? detectAtsFromText(raw.pageUrl).atsType : "unknown",
    topLevelKeys: Object.keys(raw),
    fieldCount: Array.isArray(raw.fields) ? raw.fields.length : 0,
    validationErrorPaths: parsed.error.issues.map((i) => i.path.join(".")),
    issues: parsed.error.issues.map((i) => ({
      path: i.path.join("."),
      code: i.code,
      message: i.message,
      expected: "expected" in i ? i.expected : undefined,
      received: "received" in i ? i.received : undefined,
    })),
  };

  console.error("[FORM_DESCRIPTION_VALIDATION_FAILED]", JSON.stringify(sanitizedLog, null, 2));

  return {
    success: false,
    diagnostic: {
      errorCode: "FORM_DESCRIPTION_INVALID",
      validationPath: pathString || null,
      message,
      sanitizedLog,
    },
  };
}
