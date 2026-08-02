import { describe, expect, it } from "vitest";
import {
  describeJobsQueryError,
  jobsQueryErrorDevDetail,
  jobsQueryErrorLog,
  redactQueryErrorMessage,
} from "./jobsQueryError";

/**
 * The exact error the running web process produced on the Jobs page after the
 * source-posted-date sort shipped: Prisma Client validation rejected the field
 * before any SQL was built, because the process still held a client generated
 * before `sourcePostedAt` existed.
 */
function staleClientError(): Error {
  const error = new Error(
    "\nInvalid `prisma.job.findMany()` invocation in\n"
    + "C:\\Users\\someone\\Desktop\\Internship-AI\\src\\app\\api\\jobs\\route.ts:107:31\n\n"
    + "  orderBy: [\n    { sourcePostedAt: \"desc\" },\n    { sourceRowIndex: \"asc\" }\n  ]\n\n"
    + "Unknown argument `sourcePostedAt`. Available options are marked with ?.",
  );
  error.name = "PrismaClientValidationError";
  return error;
}

describe("describeJobsQueryError", () => {
  it("identifies a stale Prisma Client and names the command that fixes it", () => {
    const report = describeJobsQueryError(staleClientError());

    expect(report.cause).toBe("STALE_PRISMA_CLIENT");
    expect(report.name).toBe("PrismaClientValidationError");
    expect(report.remedy).toEqual(["npx prisma generate", "restart the web process"]);
    // The exact ORM sentence survives — that is the point of logging at all.
    expect(report.message).toContain("Unknown argument `sourcePostedAt`");
  });

  it("distinguishes a database that never received the migration", () => {
    const error = Object.assign(new Error("no such column: Job.sourcePostedAt"), {
      name: "PrismaClientKnownRequestError",
      code: "P2022",
    });
    const report = describeJobsQueryError(error);

    expect(report.cause).toBe("MIGRATION_NOT_APPLIED");
    expect(report.code).toBe("P2022");
    expect(report.remedy[0]).toBe("npx prisma migrate deploy");
  });

  it("does not blame the schema for an unreachable database", () => {
    const report = describeJobsQueryError(new Error("SQLITE_CANTOPEN: unable to open database file"));
    expect(report.cause).toBe("DATABASE_UNAVAILABLE");
  });

  it("falls back to UNKNOWN rather than guessing", () => {
    expect(describeJobsQueryError(new Error("something else went wrong")).cause).toBe("UNKNOWN");
    expect(describeJobsQueryError("not an error").cause).toBe("UNKNOWN");
  });
});

describe("redaction", () => {
  it("removes connection strings, credentials and absolute paths", () => {
    const raw = [
      "datasource url: file:./dev.db",
      "libsql://internship-pilot.turso.io?authToken=abc.def.ghi",
      'GMAIL_TOKEN_ENCRYPTION_KEY="s3cr3t-value"',
      "at C:\\Users\\someone\\Desktop\\Internship-AI\\src\\lib\\db.ts",
      "at /home/someone/app/src/lib/db.ts",
    ].join("\n");

    const redacted = redactQueryErrorMessage(raw);

    expect(redacted).not.toContain("dev.db");
    expect(redacted).not.toContain("turso.io");
    expect(redacted).not.toContain("abc.def.ghi");
    expect(redacted).not.toContain("s3cr3t-value");
    expect(redacted).not.toContain("C:\\Users\\someone");
    expect(redacted).not.toContain("/home/someone");
  });

  it("removes long free-text values that could be a description or profile answer", () => {
    const description = "Build and test embedded firmware, analyze device data, document results, and collaborate with engineers throughout the product lifecycle.";
    const redacted = redactQueryErrorMessage(`where: { description: { contains: "${description}" } }`);

    expect(redacted).not.toContain("embedded firmware");
    expect(redacted).toContain("<redacted-long-value>");
  });

  it("bounds the message so one ORM error cannot flood the log", () => {
    const redacted = redactQueryErrorMessage("x".repeat(20_000));
    expect(redacted.length).toBeLessThan(4_100);
    expect(redacted).toContain("(truncated)");
  });
});

describe("jobsQueryErrorLog", () => {
  it("carries the caller's context plus a redacted, classified error", () => {
    const logged = jobsQueryErrorLog(staleClientError(), { requestPath: "/api/jobs", sort: "newest" });

    expect(logged).toMatchObject({
      requestPath: "/api/jobs",
      sort: "newest",
      cause: "STALE_PRISMA_CLIENT",
      errorName: "PrismaClientValidationError",
      errorCode: "NONE",
    });
    expect(logged.remedy).toBe("npx prisma generate → restart the web process");
    expect(logged.error).not.toContain("C:\\Users\\someone");
  });
});

describe("jobsQueryErrorDevDetail", () => {
  it("is withheld in production", () => {
    expect(jobsQueryErrorDevDetail(staleClientError(), "production")).toBeUndefined();
  });

  it("is returned in development, already redacted", () => {
    const detail = jobsQueryErrorDevDetail(staleClientError(), "development");
    expect(detail?.cause).toBe("STALE_PRISMA_CLIENT");
    expect(detail?.error).not.toContain("C:\\Users\\someone");
  });
});
