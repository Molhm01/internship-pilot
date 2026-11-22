import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "@/generated/prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  mockPrisma: PrismaClient | undefined;
  prismaSchemaFingerprint: string | undefined;
  pgProbePromise: Promise<boolean> | undefined;
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
      "Neither DATABASE_URL_POOLED nor DATABASE_URL is set. Point one at a PostgreSQL database — `npx prisma dev` starts one locally, and Vercel injects it when a Prisma Postgres store is connected.",
    );
    this.name = "DatabaseUrlMissingError";
  }
}

function isPlaceholderDatabaseUrl(url: string): boolean {
  return /^postgres(?:ql)?:\/\/user:password@(?:localhost|127\.0\.0\.1)(?::\d+)?\//i.test(url.trim());
}

function connectionString(): string {
  const url = process.env.DATABASE_URL_POOLED?.trim() || process.env.DATABASE_URL?.trim();
  if (!url || isPlaceholderDatabaseUrl(url)) throw new DatabaseUrlMissingError();
  if (url.startsWith("file:")) {
    throw new Error(
      "DATABASE_URL still points at a SQLite file. Internship Pilot now runs on PostgreSQL — see prisma/README.md for the one-command migration of an existing dev.db.",
    );
  }
  return url;
}

function probeTcpReachable(url: string, timeoutMs = 800): Promise<boolean> {
  if (globalForPrisma.pgProbePromise) return globalForPrisma.pgProbePromise;
  globalForPrisma.pgProbePromise = new Promise<boolean>((resolve) => {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname;
      const port = Number(parsed.port || 5432);
      const socket = net.createConnection({ host, port });
      const finish = (ok: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
    } catch {
      resolve(false);
    }
  });
  return globalForPrisma.pgProbePromise;
}

function wrapWithConnectivityFallback(realClient: PrismaClient, url: string): PrismaClient {
  let active: PrismaClient = realClient;
  let checked = false;

  const ensureActiveClient = async (): Promise<PrismaClient> => {
    if (checked) return active;
    const reachable = await probeTcpReachable(url);
    checked = true;
    if (!reachable) {
      if (!globalForPrisma.mockPrisma) {
        console.warn(
          "[AI Studio] PostgreSQL server unreachable — falling back to persistent local JSON store.",
        );
        void realClient.$disconnect().catch(() => undefined);
        globalForPrisma.mockPrisma = createMockPrismaClient();
      }
      active = globalForPrisma.mockPrisma;
      globalForPrisma.prisma = globalForPrisma.mockPrisma;
    }
    return active;
  };

  return new Proxy(realClient, {
    get(_target, prop) {
      if (prop === "$connect" || prop === "$disconnect") {
        return async () => {
          const client = await ensureActiveClient();
          return (client[prop] as () => Promise<void>)();
        };
      }
      if (prop === "$queryRaw" || prop === "$queryRawUnsafe" || prop === "$executeRaw" || prop === "$executeRawUnsafe" || prop === "$transaction") {
        return async (...args: unknown[]) => {
          const client = await ensureActiveClient();
          const fn = Reflect.get(client, prop) as (...a: unknown[]) => Promise<unknown>;
          return fn.apply(client, args);
        };
      }
      if (typeof prop === "symbol") return undefined;
      return new Proxy(
        {},
        {
          get(_dTarget, method) {
            return async (...args: unknown[]) => {
              const client = await ensureActiveClient();
              const delegate = Reflect.get(client, prop) as Record<string, (...a: unknown[]) => Promise<unknown>>;
              const fn = delegate?.[String(method)];
              if (typeof fn !== "function") {
                throw new Error(`Unknown Prisma method ${String(prop)}.${String(method)}`);
              }
              return fn.apply(delegate, args);
            };
          },
        },
      );
    },
  });
}

function createPrismaClient(): PrismaClient {
  const url = connectionString();
  const adapter = new PrismaPg({
    connectionString: url,
    max: Number(process.env.DATABASE_POOL_MAX ?? 2),
    idleTimeoutMillis: Number(process.env.DATABASE_IDLE_TIMEOUT_MS ?? 5_000),
    connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS ?? 15_000),
  });
  return wrapWithConnectivityFallback(new PrismaClient({ adapter }), url);
}

type StoreMap = Map<string, Record<string, unknown>[]>;
type RelationDef = {
  target: string;
  localKey: string;
  foreignKey: string;
  many: boolean;
};

const MODEL_RELATIONS: Record<string, Record<string, RelationDef>> = {
  job: {
    userStates: { target: "userJobState", localKey: "id", foreignKey: "jobId", many: true },
    matchResults: { target: "matchResult", localKey: "id", foreignKey: "jobId", many: true },
    generatedDocuments: { target: "generatedDocument", localKey: "id", foreignKey: "jobId", many: true },
    applicationRuns: { target: "applicationRun", localKey: "id", foreignKey: "jobId", many: true },
    verificationAttempts: { target: "verificationAttempt", localKey: "id", foreignKey: "jobId", many: true },
    initialAiMatchJobs: { target: "initialAiMatchJob", localKey: "id", foreignKey: "jobId", many: true },
  },
  company: {
    approvedAtsTenants: { target: "approvedAtsTenant", localKey: "id", foreignKey: "companyId", many: true },
    officialBoardPolls: { target: "officialBoardPoll", localKey: "id", foreignKey: "companyId", many: true },
  },
  approvedAtsTenant: {
    company: { target: "company", localKey: "companyId", foreignKey: "id", many: false },
  },
  officialBoardPoll: {
    company: { target: "company", localKey: "companyId", foreignKey: "id", many: false },
  },
  applicationRun: {
    job: { target: "job", localKey: "jobId", foreignKey: "id", many: false },
    user: { target: "user", localKey: "userId", foreignKey: "id", many: false },
  },
  matchResult: {
    job: { target: "job", localKey: "jobId", foreignKey: "id", many: false },
    user: { target: "user", localKey: "userId", foreignKey: "id", many: false },
    initialAiMatchJob: { target: "initialAiMatchJob", localKey: "id", foreignKey: "matchResultId", many: false },
  },
  initialAiMatchJob: {
    job: { target: "job", localKey: "jobId", foreignKey: "id", many: false },
    user: { target: "user", localKey: "userId", foreignKey: "id", many: false },
    matchResult: { target: "matchResult", localKey: "matchResultId", foreignKey: "id", many: false },
  },
  generatedDocument: {
    job: { target: "job", localKey: "jobId", foreignKey: "id", many: false },
    user: { target: "user", localKey: "userId", foreignKey: "id", many: false },
  },
  userJobState: {
    job: { target: "job", localKey: "jobId", foreignKey: "id", many: false },
    user: { target: "user", localKey: "userId", foreignKey: "id", many: false },
  },
  verificationAttempt: {
    job: { target: "job", localKey: "jobId", foreignKey: "id", many: false },
  },
  session: {
    user: { target: "user", localKey: "userId", foreignKey: "id", many: false },
  },
  account: {
    user: { target: "user", localKey: "userId", foreignKey: "id", many: false },
  },
  userSession: {
    user: { target: "user", localKey: "userId", foreignKey: "id", many: false },
  },
  extensionToken: {
    user: { target: "user", localKey: "userId", foreignKey: "id", many: false },
  },
  userProfile: {
    user: { target: "user", localKey: "userId", foreignKey: "id", many: false },
  },
  applicationPreferences: {
    user: { target: "user", localKey: "userId", foreignKey: "id", many: false },
  },
  sensitiveAnswerPreferences: {
    user: { target: "user", localKey: "userId", foreignKey: "id", many: false },
  },
  education: {
    user: { target: "user", localKey: "userId", foreignKey: "id", many: false },
  },
  experience: {
    user: { target: "user", localKey: "userId", foreignKey: "id", many: false },
  },
  project: {
    user: { target: "user", localKey: "userId", foreignKey: "id", many: false },
  },
  approvedAnswer: {
    user: { target: "user", localKey: "userId", foreignKey: "id", many: false },
  },
  resumeFact: {
    user: { target: "user", localKey: "userId", foreignKey: "id", many: false },
  },
  resumeDocument: {
    user: { target: "user", localKey: "userId", foreignKey: "id", many: false },
  },
  resumeBullet: {
    user: { target: "user", localKey: "userId", foreignKey: "id", many: false },
  },
  companyRelationshipFact: {
    user: { target: "user", localKey: "userId", foreignKey: "id", many: false },
  },
  savedFilter: {
    user: { target: "user", localKey: "userId", foreignKey: "id", many: false },
  },
  userSetting: {
    user: { target: "user", localKey: "userId", foreignKey: "id", many: false },
  },
  auditLogEntry: {
    user: { target: "user", localKey: "userId", foreignKey: "id", many: false },
    job: { target: "job", localKey: "jobId", foreignKey: "id", many: false },
  },
  user: {
    authSessions: { target: "session", localKey: "id", foreignKey: "userId", many: true },
    accounts: { target: "account", localKey: "id", foreignKey: "userId", many: true },
    sessions: { target: "userSession", localKey: "id", foreignKey: "userId", many: true },
    extensionTokens: { target: "extensionToken", localKey: "id", foreignKey: "userId", many: true },
    gmailAccounts: { target: "gmailAccount", localKey: "id", foreignKey: "userId", many: true },
    trackedEmails: { target: "trackedEmail", localKey: "id", foreignKey: "userId", many: true },
    assessments: { target: "assessmentInboxEntry", localKey: "id", foreignKey: "userId", many: true },
    profile: { target: "userProfile", localKey: "id", foreignKey: "userId", many: false },
    applicationPreferences: { target: "applicationPreferences", localKey: "id", foreignKey: "userId", many: false },
    sensitivePreferences: { target: "sensitiveAnswerPreferences", localKey: "id", foreignKey: "userId", many: false },
    educations: { target: "education", localKey: "id", foreignKey: "userId", many: true },
    experiences: { target: "experience", localKey: "id", foreignKey: "userId", many: true },
    projects: { target: "project", localKey: "id", foreignKey: "userId", many: true },
    savedAnswers: { target: "approvedAnswer", localKey: "id", foreignKey: "userId", many: true },
    jobStates: { target: "userJobState", localKey: "id", foreignKey: "userId", many: true },
    resumeFacts: { target: "resumeFact", localKey: "id", foreignKey: "userId", many: true },
    resumeDocuments: { target: "resumeDocument", localKey: "id", foreignKey: "userId", many: true },
    resumeBullets: { target: "resumeBullet", localKey: "id", foreignKey: "userId", many: true },
    generatedDocuments: { target: "generatedDocument", localKey: "id", foreignKey: "userId", many: true },
    companyFacts: { target: "companyRelationshipFact", localKey: "id", foreignKey: "userId", many: true },
    matchResults: { target: "matchResult", localKey: "id", foreignKey: "userId", many: true },
    initialAiMatchJobs: { target: "initialAiMatchJob", localKey: "id", foreignKey: "userId", many: true },
    applicationRuns: { target: "applicationRun", localKey: "id", foreignKey: "userId", many: true },
    savedFilters: { target: "savedFilter", localKey: "id", foreignKey: "userId", many: true },
    settings: { target: "userSetting", localKey: "id", foreignKey: "userId", many: true },
    auditLogEntries: { target: "auditLogEntry", localKey: "id", foreignKey: "userId", many: true },
  },
};

const UNIQUE_CONSTRAINTS: Record<string, string[][]> = {
  user: [["email"]],
  session: [["token"]],
  account: [["providerId", "accountId"]],
  userSession: [["tokenHash"]],
  extensionToken: [["tokenHash"]],
  userProfile: [["userId"]],
  applicationPreferences: [["userId"]],
  sensitiveAnswerPreferences: [["userId"]],
  company: [["name"]],
  employerBoardResolution: [["normalizedCompany"]],
  newEmployerReview: [["employerName"]],
  nearbyFirm: [["placeId"]],
  appSetting: [["key"]],
  userSetting: [["userId", "key"]],
  userJobState: [["userId", "jobId"]],
  approvedAnswer: [["userId", "questionText"]],
  companyRelationshipFact: [["userId", "companyKey"]],
  initialAiMatchJob: [["userId", "jobId", "matchType"]],
  freshSignalResolution: [["signalSource", "signalJobId"]],
  savedFilter: [["userId", "name"]],
  approvedAtsTenant: [["companyId", "atsType", "atsIdentifier"]],
  applicationRun: [["activeKey"]],
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function reviveDates(obj: unknown): unknown {
  if (typeof obj === "string" && ISO_DATE_RE.test(obj)) {
    const parsed = new Date(obj);
    return Number.isNaN(parsed.getTime()) ? obj : parsed;
  }
  if (Array.isArray(obj)) return obj.map(reviveDates);
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = reviveDates(v);
    return out;
  }
  return obj;
}

function storeFilePath(): string {
  const configured = process.env.PILOT_STORE_FILE?.trim();
  if (configured) return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
  return path.join(process.cwd(), "data", "pilot-store.json");
}

function loadPersistedStore(): StoreMap {
  const store: StoreMap = new Map();
  if (process.env.VITEST || process.env.NODE_ENV === "test") return store;
  try {
    const file = storeFilePath();
    if (!fs.existsSync(file)) return store;
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = reviveDates(JSON.parse(raw)) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      for (const [model, rows] of Object.entries(parsed)) {
        if (Array.isArray(rows)) store.set(model, rows as Record<string, unknown>[]);
      }
    }
  } catch (err) {
    console.warn("[db] could not load persisted store:", err instanceof Error ? err.message : String(err));
  }
  return store;
}

function createMockPrismaClient(): PrismaClient {
  const g = globalThis as unknown as {
    __aiStudioMockPrismaStore?: StoreMap;
    __aiStudioMockFlushTimer?: ReturnType<typeof setTimeout>;
  };
  if (!g.__aiStudioMockPrismaStore) {
    g.__aiStudioMockPrismaStore = loadPersistedStore();
  }
  const store = g.__aiStudioMockPrismaStore;

  const scheduleFlush = () => {
    if (process.env.VITEST || process.env.NODE_ENV === "test") return;
    if (g.__aiStudioMockFlushTimer) clearTimeout(g.__aiStudioMockFlushTimer);
    g.__aiStudioMockFlushTimer = setTimeout(() => {
      try {
        const file = storeFilePath();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const payload: Record<string, Record<string, unknown>[]> = {};
        for (const [k, v] of store.entries()) payload[k] = v;
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(payload), "utf-8");
        fs.renameSync(tmp, file);
      } catch {
        // Ignore persistence errors on read-only containers; memory state stays live.
      }
    }, 40);
  };

  const rowsFor = (model: string): Record<string, unknown>[] => {
    let list = store.get(model);
    if (!list) {
      list = [];
      store.set(model, list);
    }
    return list;
  };

  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    Boolean(v) && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);

  const normNull = (v: unknown) => (v === undefined ? null : v);

  const sameValue = (a: unknown, b: unknown): boolean => {
    const na = normNull(a);
    const nb = normNull(b);
    if (na instanceof Date && nb instanceof Date) return na.getTime() === nb.getTime();
    if (na instanceof Date && typeof nb === "string") return na.getTime() === new Date(nb).getTime();
    if (typeof na === "string" && nb instanceof Date) return new Date(na).getTime() === nb.getTime();
    return na === nb;
  };

  const resolveRelationRows = (
    model: string,
    row: Record<string, unknown>,
    relName: string,
  ): { def: RelationDef; rows: Record<string, unknown>[] } | null => {
    const def = MODEL_RELATIONS[model]?.[relName];
    if (!def) return null;
    const keyVal = row[def.localKey];
    if (keyVal === undefined || keyVal === null) return { def, rows: [] };
    const candidates = rowsFor(def.target).filter((r) => sameValue(r[def.foreignKey], keyVal));
    return { def, rows: candidates };
  };

  const matchesFilter = (rowVal: unknown, filter: Record<string, unknown>): boolean => {
    const insensitive = filter.mode === "insensitive";
    const norm = (v: unknown) => (insensitive && typeof v === "string" ? v.toLowerCase() : normNull(v));

    if ("equals" in filter && !sameValue(norm(rowVal), norm(filter.equals))) return false;
    if ("not" in filter) {
      if (isPlainObject(filter.not)) {
        if (matchesFilter(rowVal, filter.not)) return false;
      } else if (sameValue(norm(rowVal), norm(filter.not))) {
        return false;
      }
    }
    if ("in" in filter && Array.isArray(filter.in)) {
      if (!filter.in.some((item) => sameValue(norm(rowVal), norm(item)))) return false;
    }
    if ("notIn" in filter && Array.isArray(filter.notIn)) {
      if (filter.notIn.some((item) => sameValue(norm(rowVal), norm(item)))) return false;
    }
    if ("contains" in filter && typeof filter.contains === "string") {
      if (typeof rowVal !== "string") return false;
      if (!String(norm(rowVal)).includes(String(norm(filter.contains)))) return false;
    }
    if ("startsWith" in filter && typeof filter.startsWith === "string") {
      if (typeof rowVal !== "string") return false;
      if (!String(norm(rowVal)).startsWith(String(norm(filter.startsWith)))) return false;
    }
    if ("endsWith" in filter && typeof filter.endsWith === "string") {
      if (typeof rowVal !== "string") return false;
      if (!String(norm(rowVal)).endsWith(String(norm(filter.endsWith)))) return false;
    }
    const cmpVal = (v: unknown) =>
      v instanceof Date ? v.getTime() : typeof v === "number" ? v : typeof v === "string" && ISO_DATE_RE.test(v) ? new Date(v).getTime() : NaN;
    if ("gt" in filter && !(cmpVal(rowVal) > cmpVal(filter.gt))) return false;
    if ("gte" in filter && !(cmpVal(rowVal) >= cmpVal(filter.gte))) return false;
    if ("lt" in filter && !(cmpVal(rowVal) < cmpVal(filter.lt))) return false;
    if ("lte" in filter && !(cmpVal(rowVal) <= cmpVal(filter.lte))) return false;
    return true;
  };

  const FILTER_KEYS = new Set([
    "equals", "not", "in", "notIn", "contains", "startsWith", "endsWith",
    "gt", "gte", "lt", "lte", "mode",
  ]);

  const matchesWhere = (
    model: string,
    row: Record<string, unknown>,
    where?: Record<string, unknown>,
  ): boolean => {
    if (!where) return true;
    for (const [key, cond] of Object.entries(where)) {
      if (cond === undefined) continue;
      if (key === "AND") {
        const list = Array.isArray(cond) ? cond : [cond];
        if (!list.every((sub) => matchesWhere(model, row, sub as Record<string, unknown>))) return false;
        continue;
      }
      if (key === "OR") {
        const list = Array.isArray(cond) ? cond : [cond];
        if (!list.some((sub) => matchesWhere(model, row, sub as Record<string, unknown>))) return false;
        continue;
      }
      if (key === "NOT") {
        const list = Array.isArray(cond) ? cond : [cond];
        if (list.some((sub) => matchesWhere(model, row, sub as Record<string, unknown>))) return false;
        continue;
      }

      if (isPlainObject(cond)) {
        const resolved = resolveRelationRows(model, row, key);
        if ("some" in cond) {
          const rel = resolved ? resolved.rows : Array.isArray(row[key]) ? (row[key] as Record<string, unknown>[]) : [];
          const subModel = resolved?.def.target ?? key;
          if (!rel.some((item) => matchesWhere(subModel, item, cond.some as Record<string, unknown>))) return false;
          continue;
        }
        if ("none" in cond) {
          const rel = resolved ? resolved.rows : Array.isArray(row[key]) ? (row[key] as Record<string, unknown>[]) : [];
          const subModel = resolved?.def.target ?? key;
          if (rel.some((item) => matchesWhere(subModel, item, cond.none as Record<string, unknown>))) return false;
          continue;
        }
        if ("every" in cond) {
          const rel = resolved ? resolved.rows : Array.isArray(row[key]) ? (row[key] as Record<string, unknown>[]) : [];
          const subModel = resolved?.def.target ?? key;
          if (!rel.every((item) => matchesWhere(subModel, item, cond.every as Record<string, unknown>))) return false;
          continue;
        }
        if ("is" in cond) {
          const rel = resolved ? (resolved.rows[0] ?? null) : isPlainObject(row[key]) ? (row[key] as Record<string, unknown>) : null;
          const subModel = resolved?.def.target ?? key;
          if (cond.is === null) {
            if (rel !== null) return false;
          } else if (!rel || !matchesWhere(subModel, rel, cond.is as Record<string, unknown>)) {
            return false;
          }
          continue;
        }
        if ("isNot" in cond) {
          const rel = resolved ? (resolved.rows[0] ?? null) : isPlainObject(row[key]) ? (row[key] as Record<string, unknown>) : null;
          const subModel = resolved?.def.target ?? key;
          if (cond.isNot === null) {
            if (rel === null) return false;
          } else if (rel && matchesWhere(subModel, rel, cond.isNot as Record<string, unknown>)) {
            return false;
          }
          continue;
        }
        if (resolved && !resolved.def.many) {
          const targetRow = resolved.rows[0];
          if (!targetRow || !matchesWhere(resolved.def.target, targetRow, cond)) return false;
          continue;
        }
        // Composite unique key e.g. userId_companyKey: { userId, companyKey }
        const keys = Object.keys(cond);
        if (key.includes("_") && !(key in row) && keys.some((k) => !FILTER_KEYS.has(k))) {
          if (!matchesWhere(model, row, cond)) return false;
          continue;
        }
        if (!matchesFilter(row[key], cond)) return false;
        continue;
      }

      if (!sameValue(row[key], cond)) return false;
    }
    return true;
  };

  const compareScalar = (a: unknown, b: unknown): number => {
    const na = normNull(a);
    const nb = normNull(b);
    if (na === null && nb === null) return 0;
    if (na === null) return -1;
    if (nb === null) return 1;
    if (na instanceof Date && nb instanceof Date) return na.getTime() - nb.getTime();
    if (typeof na === "number" && typeof nb === "number") return na - nb;
    if (typeof na === "boolean" && typeof nb === "boolean") return Number(na) - Number(nb);
    return String(na).localeCompare(String(nb));
  };

  const sortRows = (rows: Record<string, unknown>[], orderBy?: unknown): Record<string, unknown>[] => {
    if (!orderBy) return rows;
    const clauses = (Array.isArray(orderBy) ? orderBy : [orderBy]).filter(isPlainObject);
    if (clauses.length === 0) return rows;
    return [...rows].sort((a, b) => {
      for (const clause of clauses) {
        for (const [field, spec] of Object.entries(clause)) {
          if (!spec) continue;
          let dir: "asc" | "desc" = "asc";
          let nulls: "first" | "last" | undefined;
          if (spec === "asc" || spec === "desc") {
            dir = spec;
          } else if (isPlainObject(spec)) {
            if (spec.sort === "asc" || spec.sort === "desc") dir = spec.sort;
            if (spec.nulls === "first" || spec.nulls === "last") nulls = spec.nulls;
          } else {
            continue;
          }
          const va = normNull(a[field]);
          const vb = normNull(b[field]);
          if (va === null && vb === null) continue;
          if (va === null) {
            if (nulls === "first") return -1;
            if (nulls === "last") return 1;
            return dir === "desc" ? 1 : -1;
          }
          if (vb === null) {
            if (nulls === "first") return 1;
            if (nulls === "last") return -1;
            return dir === "desc" ? -1 : 1;
          }
          const diff = compareScalar(va, vb);
          if (diff !== 0) return dir === "desc" ? -diff : diff;
        }
      }
      return 0;
    });
  };

  const queryRelationValue = (
    model: string,
    row: Record<string, unknown>,
    relName: string,
    subArgs: unknown,
  ): unknown => {
    const resolved = resolveRelationRows(model, row, relName);
    if (!resolved) {
      return relName.endsWith("s") ? [] : null;
    }
    const { def, rows } = resolved;
    const args = isPlainObject(subArgs) ? subArgs : {};
    let filtered = args.where
      ? rows.filter((r) => matchesWhere(def.target, r, args.where as Record<string, unknown>))
      : rows;
    if (args.orderBy) filtered = sortRows(filtered, args.orderBy);
    if (typeof args.skip === "number" || typeof args.take === "number") {
      const skip = typeof args.skip === "number" ? args.skip : 0;
      const take = typeof args.take === "number" ? args.take : filtered.length;
      filtered = filtered.slice(skip, skip + take);
    }
    const projected = filtered.map((r) =>
      applyProjection(def.target, r, {
        include: isPlainObject(args.include) ? args.include : undefined,
        select: isPlainObject(args.select) ? args.select : undefined,
      }),
    );
    return def.many ? projected : (projected[0] ?? null);
  };

  const applyProjection = (
    model: string,
    row: Record<string, unknown>,
    args?: { include?: Record<string, unknown>; select?: Record<string, unknown> },
  ): Record<string, unknown> => {
    const copy: Record<string, unknown> = { ...row };
    if (args?.include) {
      for (const [k, v] of Object.entries(args.include)) {
        if (!v) continue;
        if (k === "_count") {
          const counts: Record<string, number> = {};
          const rels = MODEL_RELATIONS[model] ?? {};
          const spec = isPlainObject(v) && isPlainObject(v.select) ? v.select : null;
          for (const relKey of Object.keys(spec ?? rels)) {
            const res = resolveRelationRows(model, row, relKey);
            counts[relKey] = res ? res.rows.length : 0;
          }
          copy._count = counts;
          continue;
        }
        copy[k] = queryRelationValue(model, row, k, v);
      }
    }
    if (args?.select) {
      const selected: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(args.select)) {
        if (!v) continue;
        if (k === "_count") {
          const counts: Record<string, number> = {};
          const rels = MODEL_RELATIONS[model] ?? {};
          const spec = isPlainObject(v) && isPlainObject(v.select) ? v.select : null;
          for (const relKey of Object.keys(spec ?? rels)) {
            const res = resolveRelationRows(model, row, relKey);
            counts[relKey] = res ? res.rows.length : 0;
          }
          selected._count = counts;
        } else if (MODEL_RELATIONS[model]?.[k]) {
          selected[k] = queryRelationValue(model, row, k, v);
        } else {
          selected[k] = k in copy ? copy[k] : null;
        }
      }
      return selected;
    }
    return copy;
  };

  const checkUniqueConstraints = (
    model: string,
    candidate: Record<string, unknown>,
    ignoreRow?: Record<string, unknown>,
  ) => {
    const constraints = UNIQUE_CONSTRAINTS[model];
    if (!constraints) return;
    const rows = rowsFor(model);
    for (const fields of constraints) {
      const vals = fields.map((f) => normNull(candidate[f]));
      // PostgreSQL allows multiple rows with NULL in nullable unique columns unless all columns are non-null
      if (vals.every((v) => v === null)) continue;
      const collision = rows.some(
        (existing) =>
          existing !== ignoreRow
          && fields.every((f, idx) => sameValue(existing[f], vals[idx]) && (vals[idx] !== null || fields.length > 1)),
      );
      if (collision) {
        throw Object.assign(
          new Error(`Unique constraint failed on ${model} (${fields.join(", ")})`),
          { code: "P2002", meta: { target: fields } },
        );
      }
    }
  };

  const normalizeMutationData = (
    model: string,
    raw: Record<string, unknown>,
  ): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    const rels = MODEL_RELATIONS[model] ?? {};
    for (const [k, v] of Object.entries(raw)) {
      if (v === undefined) continue;
      const rel = rels[k];
      if (rel && !rel.many && isPlainObject(v)) {
        if ("connect" in v && isPlainObject(v.connect) && rel.foreignKey in v.connect) {
          out[rel.localKey] = v.connect[rel.foreignKey];
        } else if ("disconnect" in v && v.disconnect) {
          out[rel.localKey] = null;
        }
        continue;
      }
      if (rel && rel.many && isPlainObject(v)) {
        continue;
      }
      out[k] = v;
    }
    return out;
  };

  const applyUpdateData = (
    model: string,
    target: Record<string, unknown>,
    rawData: Record<string, unknown>,
  ): Record<string, unknown> => {
    const data = normalizeMutationData(model, rawData);
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (isPlainObject(v)) {
        if ("set" in v) {
          target[k] = v.set;
          continue;
        }
        if ("increment" in v && typeof v.increment === "number") {
          target[k] = (typeof target[k] === "number" ? (target[k] as number) : 0) + v.increment;
          continue;
        }
        if ("decrement" in v && typeof v.decrement === "number") {
          target[k] = (typeof target[k] === "number" ? (target[k] as number) : 0) - v.decrement;
          continue;
        }
      }
      target[k] = v;
    }
    target.updatedAt = new Date();
    return target;
  };

  const createDelegate = (model: string) => ({
    findMany: async (args: Record<string, unknown> = {}) => {
      let list = rowsFor(model).filter((r) =>
        matchesWhere(model, r, args.where as Record<string, unknown> | undefined),
      );
      list = sortRows(list, args.orderBy);
      if (Array.isArray(args.distinct) && args.distinct.length > 0) {
        const seen = new Set<string>();
        const fields = args.distinct as string[];
        list = list.filter((r) => {
          const key = JSON.stringify(fields.map((f) => r[f] ?? null));
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      const skip = typeof args.skip === "number" ? args.skip : 0;
      const take = typeof args.take === "number" ? args.take : list.length;
      return list
        .slice(skip, skip + take)
        .map((r) => applyProjection(model, r, args as { include?: Record<string, unknown>; select?: Record<string, unknown> }));
    },
    findFirst: async (args: Record<string, unknown> = {}) => {
      let list = rowsFor(model).filter((r) =>
        matchesWhere(model, r, args.where as Record<string, unknown> | undefined),
      );
      if (args.orderBy) list = sortRows(list, args.orderBy);
      const found = list[0];
      return found
        ? applyProjection(model, found, args as { include?: Record<string, unknown>; select?: Record<string, unknown> })
        : null;
    },
    findFirstOrThrow: async (args: Record<string, unknown> = {}) => {
      let list = rowsFor(model).filter((r) =>
        matchesWhere(model, r, args.where as Record<string, unknown> | undefined),
      );
      if (args.orderBy) list = sortRows(list, args.orderBy);
      const found = list[0];
      if (!found) throw new Error(`Record not found in ${model}`);
      return applyProjection(model, found, args as { include?: Record<string, unknown>; select?: Record<string, unknown> });
    },
    findUnique: async (args: Record<string, unknown> = {}) => {
      const found = rowsFor(model).find((r) =>
        matchesWhere(model, r, args.where as Record<string, unknown> | undefined),
      );
      return found
        ? applyProjection(model, found, args as { include?: Record<string, unknown>; select?: Record<string, unknown> })
        : null;
    },
    findUniqueOrThrow: async (args: Record<string, unknown> = {}) => {
      const found = rowsFor(model).find((r) =>
        matchesWhere(model, r, args.where as Record<string, unknown> | undefined),
      );
      if (!found) throw new Error(`Record not found in ${model}`);
      return applyProjection(model, found, args as { include?: Record<string, unknown>; select?: Record<string, unknown> });
    },
    create: async (args: Record<string, unknown> = {}) => {
      const data = normalizeMutationData(model, (args.data as Record<string, unknown>) ?? {});
      const now = new Date();
      const row: Record<string, unknown> = {
        id: typeof data.id === "string" ? data.id : randomUUID(),
        createdAt: now,
        updatedAt: now,
        ...(model === "syncLog" ? { startedAt: now } : {}),
        ...(model === "job" ? { firstSeenAt: now } : {}),
        ...data,
      };
      checkUniqueConstraints(model, row);
      rowsFor(model).push(row);
      scheduleFlush();
      return applyProjection(model, row, args as { include?: Record<string, unknown>; select?: Record<string, unknown> });
    },
    createMany: async (args: Record<string, unknown> = {}) => {
      const items = Array.isArray(args.data) ? (args.data as Record<string, unknown>[]) : [];
      const skipDuplicates = Boolean(args.skipDuplicates);
      const now = new Date();
      let count = 0;
      for (const rawData of items) {
        const data = normalizeMutationData(model, rawData);
        const row: Record<string, unknown> = {
          id: typeof data.id === "string" ? data.id : randomUUID(),
          createdAt: now,
          updatedAt: now,
          ...(model === "syncLog" ? { startedAt: now } : {}),
          ...(model === "job" ? { firstSeenAt: now } : {}),
          ...data,
        };
        try {
          checkUniqueConstraints(model, row);
          rowsFor(model).push(row);
          count += 1;
        } catch (err) {
          if (skipDuplicates) continue;
          throw err;
        }
      }
      scheduleFlush();
      return { count };
    },
    update: async (args: Record<string, unknown> = {}) => {
      const where = args.where as Record<string, unknown> | undefined;
      const data = (args.data as Record<string, unknown>) ?? {};
      const found = rowsFor(model).find((r) => matchesWhere(model, r, where));
      if (!found) {
        throw Object.assign(new Error(`Record to update not found in ${model}`), { code: "P2025" });
      }
      const next = applyUpdateData(model, { ...found }, data);
      checkUniqueConstraints(model, next, found);
      applyUpdateData(model, found, data);
      scheduleFlush();
      return applyProjection(model, found, args as { include?: Record<string, unknown>; select?: Record<string, unknown> });
    },
    updateMany: async (args: Record<string, unknown> = {}) => {
      const where = args.where as Record<string, unknown> | undefined;
      const data = (args.data as Record<string, unknown>) ?? {};
      let count = 0;
      for (const row of rowsFor(model)) {
        if (matchesWhere(model, row, where)) {
          applyUpdateData(model, row, data);
          count++;
        }
      }
      if (count > 0) scheduleFlush();
      return { count };
    },
    upsert: async (args: Record<string, unknown> = {}) => {
      const where = args.where as Record<string, unknown> | undefined;
      const found = rowsFor(model).find((r) => matchesWhere(model, r, where));
      if (found) {
        applyUpdateData(model, found, (args.update as Record<string, unknown>) ?? {});
        scheduleFlush();
        return applyProjection(model, found, args as { include?: Record<string, unknown>; select?: Record<string, unknown> });
      }
      const createData = normalizeMutationData(model, (args.create as Record<string, unknown>) ?? {});
      const now = new Date();
      const row: Record<string, unknown> = {
        id: typeof createData.id === "string" ? createData.id : randomUUID(),
        createdAt: now,
        updatedAt: now,
        ...createData,
      };
      checkUniqueConstraints(model, row);
      rowsFor(model).push(row);
      scheduleFlush();
      return applyProjection(model, row, args as { include?: Record<string, unknown>; select?: Record<string, unknown> });
    },
    delete: async (args: Record<string, unknown> = {}) => {
      const list = rowsFor(model);
      const idx = list.findIndex((r) =>
        matchesWhere(model, r, args.where as Record<string, unknown> | undefined),
      );
      if (idx === -1) {
        throw Object.assign(new Error(`Record to delete not found in ${model}`), { code: "P2025" });
      }
      const [removed] = list.splice(idx, 1);
      scheduleFlush();
      return removed;
    },
    deleteMany: async (args: Record<string, unknown> = {}) => {
      const list = rowsFor(model);
      const where = args.where as Record<string, unknown> | undefined;
      const kept = list.filter((r) => !matchesWhere(model, r, where));
      const count = list.length - kept.length;
      store.set(model, kept);
      if (count > 0) scheduleFlush();
      return { count };
    },
    count: async (args: Record<string, unknown> = {}) =>
      rowsFor(model).filter((r) =>
        matchesWhere(model, r, args.where as Record<string, unknown> | undefined),
      ).length,
    aggregate: async (args: Record<string, unknown> = {}) => {
      const rows = rowsFor(model).filter((r) =>
        matchesWhere(model, r, args.where as Record<string, unknown> | undefined),
      );
      return { _count: { _all: rows.length } };
    },
    groupBy: async (args: Record<string, unknown> = {}) => {
      const by = Array.isArray(args.by) ? (args.by as string[]) : [];
      const rows = rowsFor(model).filter((r) =>
        matchesWhere(model, r, args.where as Record<string, unknown> | undefined),
      );
      const groups = new Map<string, { keys: Record<string, unknown>; count: number }>();
      for (const row of rows) {
        const keyObj: Record<string, unknown> = {};
        for (const f of by) keyObj[f] = row[f] ?? null;
        const hash = JSON.stringify(keyObj);
        const existing = groups.get(hash);
        if (existing) existing.count += 1;
        else groups.set(hash, { keys: keyObj, count: 1 });
      }
      return Array.from(groups.values()).map((g) => ({
        ...g.keys,
        _count: args._count ? (isPlainObject(args._count) ? { _all: g.count, ...Object.fromEntries(Object.keys(args._count).map((k) => [k, g.count])) } : g.count) : undefined,
      }));
    },
  });

  const delegates = new Map<string, ReturnType<typeof createDelegate>>();

  const mockProxy: PrismaClient = new Proxy({} as PrismaClient, {
    get(_target, prop) {
      if (prop === "$connect" || prop === "$disconnect") return async () => {};
      if (prop === "$queryRaw" || prop === "$queryRawUnsafe") return async () => [];
      if (prop === "$executeRaw" || prop === "$executeRawUnsafe") return async () => 0;
      if (prop === "$transaction") {
        return async (arg: unknown) => {
          if (Array.isArray(arg)) return Promise.all(arg);
          if (typeof arg === "function") return (arg as (tx: PrismaClient) => Promise<unknown>)(mockProxy);
          return null;
        };
      }
      if (typeof prop === "symbol") return undefined;
      let delegate = delegates.get(prop);
      if (!delegate) {
        delegate = createDelegate(prop);
        delegates.set(prop, delegate);
      }
      return delegate;
    },
  });

  return mockProxy;
}

/**
 * Builds (or reuses) the real client, or falls back to an in-memory mock when
 * DATABASE_URL is not configured. Called on first property access, never at
 * import time.
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

  let client: PrismaClient;
  try {
    client = createPrismaClient();
  } catch (error) {
    console.warn(
      "[AI Studio] Database not connected — using mock:",
      error instanceof Error ? error.message : String(error),
    );
    client = createMockPrismaClient();
  }
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
