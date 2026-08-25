import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "@/generated/prisma/client";

/**
 * The Prisma client, over PostgreSQL.
 *
 * This used to be SQLite through libsql, which is the right database for one
 * user on one laptop and the wrong one for a deployment: Vercel's filesystem is
 * ephemeral, so a `file:./dev.db` would be recreated empty on every cold start
 * and silently lose every row written by the previous invocation.
 *
 * Connection handling is the other half of that move. A serverless function is
 * one short-lived process among many, and each one opening a pool would exhaust
 * the database's connection limit long before it exhausts anything else. The
 * pool is therefore small by default and configurable, and the client is cached
 * on globalThis so warm invocations reuse the connections they already hold.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  prismaSchemaFingerprint: string | undefined;
};

/**
 * Identity of the Prisma Client currently loaded, derived from the generated
 * `*ScalarFieldEnum` objects — i.e. every model and every field this client
 * knows about. Cheap, and it changes exactly when a regenerate matters.
 *
 * This exists because of a real failure: the dev server had been running since
 * before `prisma generate`, hot reload re-executed a route with a NEW query
 * against the OLD cached client, and Prisma rejected `orderBy: sourcePostedAt`
 * with "Unknown argument" before any SQL was sent. Keying the cache on the
 * generated field list drops the stale instance instead.
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

export class DatabaseUrlMissingError extends Error {
  readonly code = "DATABASE_URL_MISSING";

  constructor() {
    super(
      "DATABASE_URL is not set. Point it at a PostgreSQL database — `npx prisma dev` starts one locally, and Vercel injects it when a Prisma Postgres store is connected.",
    );
    this.name = "DatabaseUrlMissingError";
  }
}

function connectionString(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new DatabaseUrlMissingError();
  if (url.startsWith("file:")) {
    throw new Error(
      "DATABASE_URL still points at a SQLite file. Internship Pilot now runs on PostgreSQL — see prisma/README.md for the one-command migration of an existing dev.db.",
    );
  }
  return url;
}

/**
 * Operation-budget counter (database-usage repair, pass #2 — item 11).
 *
 * Opt-in only: disabled unless PRISMA_OPERATION_BUDGET_TRACKING=1 is set, so
 * it costs nothing in production or in the default test run. Its only job is
 * to let a test assert "this recurring pipeline issued at most N Prisma
 * calls for this input", as regression protection against silently
 * reintroducing an unbounded loop, a full-table scan fed into per-row calls,
 * or a duplicate scheduler — the exact shape of the problems that produced
 * the original Free-plan overage. It counts CALLS (one per `prisma.model.op`
 * invocation), matching how this repo's own usage estimates are built
 * throughout the DATABASE USAGE DIAGNOSTIC / DATABASE EFFICIENCY REPAIR
 * reports — not rows returned, which Prisma's own operation billing does not
 * key off either.
 */
let operationCount = 0;
const OPERATION_BUDGET_TRACKING_ENABLED = process.env.PRISMA_OPERATION_BUDGET_TRACKING === "1";

/** Resets the counter. Call before the pipeline under test. */
export function resetPrismaOperationCounter(): void {
  operationCount = 0;
}

/** Current count since the last reset. */
export function getPrismaOperationCount(): number {
  return operationCount;
}

/**
 * Forces the next `prisma.*` call to rebuild the cached client.
 *
 * Test-only. The client is cached on `globalThis` per process/module
 * registry (see resolveClient below), keyed on the generated-schema
 * fingerprint — which does not change when PRISMA_OPERATION_BUDGET_TRACKING
 * is toggled. A budget test that sets that env var after some earlier test
 * already built the client would otherwise silently get the uninstrumented
 * cached instance. Calling this after setting the env var guarantees a fresh,
 * instrumented client instead.
 */
export function resetPrismaClientForTests(): void {
  globalForPrisma.prisma = undefined;
  globalForPrisma.prismaSchemaFingerprint = undefined;
}

function createPrismaClient() {
  const adapter = new PrismaPg({
    connectionString: connectionString(),
    // Serverless invocations are numerous and short. A large pool per instance
    // is how a project runs out of Postgres connections while barely under
    // load; the pooled connection string handles concurrency instead.
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    // The old libsql timeout existed because the web app, scheduler, and
    // application worker are separate local processes contending for one
    // SQLite write lock. Postgres has row-level locking, but the same three
    // processes still want a bounded wait rather than an instant failure.
    connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS ?? 15_000),
  });
  const client = new PrismaClient({ adapter });
  if (!OPERATION_BUDGET_TRACKING_ENABLED) return client;

  return client.$extends({
    name: "operation-budget-counter",
    query: {
      $allModels: {
        async $allOperations({ query, args }) {
          operationCount += 1;
          return query(args);
        },
      },
    },
  }) as unknown as PrismaClient;
}

/**
 * Builds (or reuses) the real client. Called on first property access, never
 * at import time.
 */
function resolveClient(): PrismaClient {
  const fingerprint = generatedClientFingerprint();
  const cachedIsCurrent =
    globalForPrisma.prisma !== undefined && globalForPrisma.prismaSchemaFingerprint === fingerprint;
  if (cachedIsCurrent) return globalForPrisma.prisma!;

  if (globalForPrisma.prisma) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[db] Prisma Client was regenerated since this process started — rebuilding the cached client.",
      );
    }
    // Fire-and-forget: the old instance is unreachable from here on, and a
    // failure to close it must never take down the request that replaced it.
    void globalForPrisma.prisma.$disconnect().catch(() => undefined);
  }

  const client = createPrismaClient();
  // Cached in every environment, not just development. On Vercel a warm
  // function re-executes module scope rarely but not never, and reusing the
  // pool across invocations of the same instance is the difference between a
  // handful of connections and one per request.
  globalForPrisma.prisma = client;
  globalForPrisma.prismaSchemaFingerprint = fingerprint;
  return client;
}

/**
 * The client, constructed on first use.
 *
 * Laziness is load-bearing, not a micro-optimization. `next build` imports
 * every route module to collect page data, and a client built at import time
 * would demand DATABASE_URL during the build — turning a missing environment
 * variable into a failed deployment instead of a failed request. It also lets
 * unit tests import a module that happens to `import { prisma }` without
 * standing up a database.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    const value = Reflect.get(resolveClient(), property, receiver);
    return typeof value === "function" ? value.bind(resolveClient()) : value;
  },
  has: (_target, property) => property in resolveClient(),
  ownKeys: () => Reflect.ownKeys(resolveClient()),
  getOwnPropertyDescriptor: (_target, property) =>
    Reflect.getOwnPropertyDescriptor(resolveClient(), property),
});
