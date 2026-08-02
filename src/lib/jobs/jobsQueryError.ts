// How a failed Jobs database query is turned into a log line and a response.
//
// Two things went wrong the first time the Jobs feed broke after the
// source-posted-date sort landed (see JOB_FRESHNESS_SORT_AUDIT.md):
//
//  1. The web process kept a PrismaClient built from a Prisma Client that was
//     generated BEFORE `sourcePostedAt` existed, so `orderBy: sourcePostedAt`
//     was rejected by client-side validation before any SQL was sent.
//  2. The route logged only `error.message`, so the console said nothing about
//     which field, which client, or what to run — the page just said the query
//     failed.
//
// This module fixes (2) and makes (1) self-diagnosing: the exact ORM error is
// logged, with a named cause and the command that repairs it, and never with a
// connection string, credential, job description or profile field in it.

/** Fields the freshness ordering depends on. */
export const FRESHNESS_FIELDS = [
  "sourcePostedAt",
  "sourcePostedText",
  "sourceDateConfidence",
  "sourceCapturedAt",
  "sourceSyncRunId",
  "sourceRowIndex",
] as const;

export type JobsQueryCause =
  | "STALE_PRISMA_CLIENT"
  | "MIGRATION_NOT_APPLIED"
  | "UNKNOWN_ORM_ARGUMENT"
  | "DATABASE_UNAVAILABLE"
  | "UNKNOWN";

export type JobsQueryErrorReport = {
  /** Error class name, e.g. PrismaClientValidationError. */
  name: string;
  /** Prisma error code when there is one, e.g. P2022. */
  code: string | null;
  /** The exact ORM error text, redacted and length-bounded. */
  message: string;
  cause: JobsQueryCause;
  /** Plain-language explanation of what the ORM error means here. */
  explanation: string;
  /** The exact command(s) that repair it, in order. */
  remedy: string[];
};

// Anything that could carry a secret or the user's own data. Job descriptions
// and profile text never appear in a Jobs `where`, but a redaction pass is
// cheap insurance against a future filter that does.
const REDACTIONS: [RegExp, string][] = [
  // Connection strings of every shape Prisma accepts.
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`)]+/gi, "<redacted-url>"],
  [/\bfile:[^\s"'`)]+/gi, "<redacted-url>"],
  // key=value / key: "value" pairs whose key reads like a secret. The leading
  // [\w-]* matters: the name to redact is usually a prefixed environment
  // variable such as GMAIL_TOKEN_ENCRYPTION_KEY, not a bare "key".
  [/\b([\w-]*(?:token|password|passwd|secret|credential|key))\b\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi, "$1=<redacted>"],
  // Absolute filesystem paths (Windows and POSIX).
  [/\b[A-Za-z]:\\[^\s"'`)]+/g, "<redacted-path>"],
  [/(?<![\w.])\/(?:home|Users|var|etc|opt|root)\/[^\s"'`)]+/g, "<redacted-path>"],
  // Any long free-text literal — a description or profile answer would look
  // like this, and no useful ORM diagnostic needs more than 80 characters of
  // a single quoted value.
  [/"[^"\n]{81,}"/g, '"<redacted-long-value>"'],
];

const MAX_MESSAGE_CHARS = 4000;

/** Strip secrets and user data from an ORM error message, then bound it. */
export function redactQueryErrorMessage(raw: string): string {
  let message = raw;
  for (const [pattern, replacement] of REDACTIONS) {
    message = message.replace(pattern, replacement);
  }
  return message.length > MAX_MESSAGE_CHARS
    ? `${message.slice(0, MAX_MESSAGE_CHARS)}\n… (truncated)`
    : message;
}

function errorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string" && code) return code;
  }
  return null;
}

function mentionsFreshnessField(message: string): boolean {
  return FRESHNESS_FIELDS.some((field) => message.includes(field));
}

/**
 * Classify a failed Jobs query.
 *
 * The two failures this ordering can realistically produce are told apart by
 * WHERE the rejection happened:
 *
 *  - Prisma Client validation rejects the field before any SQL is built ⇒ the
 *    loaded Prisma Client does not know the field. The generated client is
 *    stale relative to prisma/schema.prisma, or the process that loaded it
 *    started before `prisma generate` ran. Regenerate, then restart.
 *  - SQLite rejects the column (P2022) ⇒ the client is current but the
 *    database file never received the migration. Apply the migration.
 */
export function describeJobsQueryError(error: unknown): JobsQueryErrorReport {
  const name = error instanceof Error ? error.name : typeof error;
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = redactQueryErrorMessage(rawMessage);
  const code = errorCode(error);

  const unknownArgument = /Unknown argument|Unknown field|Unknown arg /i.test(rawMessage)
    || name === "PrismaClientValidationError";

  if (code === "P2022" || /no such column|column .* does not exist/i.test(rawMessage)) {
    return {
      name,
      code,
      message,
      cause: "MIGRATION_NOT_APPLIED",
      explanation:
        "The database is missing a column the Jobs query orders by. The migration that adds the canonical source-posting columns has not been applied to this database file.",
      remedy: ["npx prisma migrate deploy", "npx prisma generate", "restart the web process"],
    };
  }

  if (unknownArgument && mentionsFreshnessField(rawMessage)) {
    return {
      name,
      code,
      message,
      cause: "STALE_PRISMA_CLIENT",
      explanation:
        "Prisma Client rejected a source-posting field before sending any SQL, so the loaded client predates the canonical source-posted-date schema. The generated client is stale, or this process started before it was regenerated.",
      remedy: ["npx prisma generate", "restart the web process"],
    };
  }

  if (unknownArgument) {
    return {
      name,
      code,
      message,
      cause: "UNKNOWN_ORM_ARGUMENT",
      explanation:
        "Prisma Client rejected an argument in the Jobs query. A field name in the query does not match prisma/schema.prisma.",
      remedy: ["npx prisma validate", "npx prisma generate", "restart the web process"],
    };
  }

  if (/SQLITE_|unable to open database|database is locked|ECONNREFUSED|P1\d{3}/i.test(rawMessage)
    || (code !== null && code.startsWith("P1"))) {
    return {
      name,
      code,
      message,
      cause: "DATABASE_UNAVAILABLE",
      explanation: "The Jobs query could not reach or read the database file.",
      remedy: ["npx prisma migrate status", "restart the web process"],
    };
  }

  return {
    name,
    code,
    message,
    cause: "UNKNOWN",
    explanation: "The Jobs database query failed.",
    remedy: ["npx prisma migrate status"],
  };
}

/**
 * The object handed to console.error. Every field here is safe to write to a
 * log file: no connection string, no credential, no job description, no
 * profile data — only schema-level names and the redacted ORM message.
 */
export function jobsQueryErrorLog(error: unknown, context: Record<string, string> = {}) {
  const report = describeJobsQueryError(error);
  return {
    ...context,
    cause: report.cause,
    errorName: report.name,
    errorCode: report.code ?? "NONE",
    explanation: report.explanation,
    remedy: report.remedy.join(" → "),
    error: report.message,
  };
}

/**
 * Extra detail attached to the 500 body outside production. This app is
 * local-only, and a developer staring at the Jobs page needs the cause and the
 * command, not a trip to a separate terminal. Still redacted — the same text
 * that went to the log, never anything more.
 */
export function jobsQueryErrorDevDetail(
  error: unknown,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): { cause: JobsQueryCause; explanation: string; remedy: string[]; error: string } | undefined {
  if (nodeEnv === "production") return undefined;
  const report = describeJobsQueryError(error);
  return {
    cause: report.cause,
    explanation: report.explanation,
    remedy: report.remedy,
    error: report.message,
  };
}
