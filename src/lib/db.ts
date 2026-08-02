import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient, Prisma } from "@/generated/prisma/client";

// Outside production the client is cached on globalThis so hot reload does not
// open a new SQLite connection on every edit. That cache is also how the Jobs
// feed broke after the source-posted-date change: the web process had been
// running since before `prisma generate`, hot reload re-executed the route with
// the NEW query but kept the OLD cached client, and Prisma Client validation
// rejected `orderBy: { sourcePostedAt: "desc" }` with "Unknown argument
// `sourcePostedAt`" before any SQL was sent.
//
// So the cache is keyed by the generated client's own field list. Regenerating
// the client changes the key, the stale instance is dropped, and the next
// request builds a client that matches prisma/schema.prisma. Same connection
// reuse as before for every edit that does NOT touch the schema.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  prismaSchemaFingerprint: string | undefined;
};

/**
 * Identity of the Prisma Client currently loaded, derived from the generated
 * `*ScalarFieldEnum` objects — i.e. every model and every field this client
 * knows about. Cheap, and it changes exactly when a regenerate matters.
 */
function generatedClientFingerprint(): string {
  const namespace = Prisma as unknown as Record<string, unknown>;
  return Object.keys(namespace)
    .filter((key) => key.endsWith("ScalarFieldEnum"))
    .sort()
    .map((key) => {
      const fields = namespace[key];
      const names = fields && typeof fields === "object" ? Object.keys(fields).sort() : [];
      return `${key}:${names.join(",")}`;
    })
    .join("|");
}

function createPrismaClient() {
  const adapter = new PrismaLibSql({
    url: process.env.DATABASE_URL ?? "file:./dev.db",
    // Web routes, scheduler, and the single application worker are separate
    // local processes. Wait for short SQLite write locks instead of failing
    // immediately while another service commits its transaction.
    timeout: 15_000,
  });
  return new PrismaClient({ adapter });
}

const fingerprint = generatedClientFingerprint();
const cachedIsCurrent =
  globalForPrisma.prisma !== undefined && globalForPrisma.prismaSchemaFingerprint === fingerprint;

export const prisma = cachedIsCurrent ? globalForPrisma.prisma! : createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  if (!cachedIsCurrent && globalForPrisma.prisma) {
    console.warn(
      "[db] Prisma Client was regenerated since this process started — rebuilding the cached client.",
    );
    // Fire-and-forget: the old instance is unreachable from here on, and a
    // failure to close it must never take down the request that replaced it.
    void globalForPrisma.prisma.$disconnect().catch(() => undefined);
  }
  globalForPrisma.prisma = prisma;
  globalForPrisma.prismaSchemaFingerprint = fingerprint;
}
