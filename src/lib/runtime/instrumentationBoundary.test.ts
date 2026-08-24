import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Next's instrumentation module is compiled into the server bundle by whichever
 * bundler is running. When it reached the scheduler, the import chain was
 *
 *   src/instrumentation.ts
 *     -> src/lib/sync/scheduler.ts
 *       -> src/lib/db.ts
 *         -> @prisma/adapter-pg -> pg -> pgpass -> node:fs, node:path
 *
 * and Windows Webpack resolved those Node built-ins as browser modules:
 * "Module not found: Can't resolve 'fs'", then the same for 'path'. The whole
 * website stopped compiling.
 *
 * The scheduler now runs as its own Node process, so nothing in the
 * instrumentation import closure may reach server-only infrastructure again.
 * This walks the real import graph rather than checking the one file, because
 * the regression was transitive: instrumentation.ts itself looked harmless.
 */

const REPO_ROOT = process.cwd();
const ENTRY = "src/instrumentation.ts";

const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

// Packages that drag Node built-ins (or a browser engine) into a bundle.
const FORBIDDEN_PACKAGES = [
  "@prisma/client",
  "@prisma/adapter-pg",
  "prisma",
  "pg",
  "pg-pool",
  "pgpass",
  "playwright",
  "playwright-core",
  "puppeteer",
  "googleapis",
  "google-auth-library",
];

// Local modules whose whole point is server-only long-lived work.
const FORBIDDEN_LOCAL_MODULES: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /^src\/lib\/db\.ts$/, why: "Prisma/pg client" },
  { pattern: /^src\/lib\/sync\/scheduler\.ts$/, why: "the standalone scheduler" },
  { pattern: /^src\/lib\/sync\//, why: "discovery/ingest" },
  { pattern: /^src\/lib\/gmail\//, why: "Gmail sync" },
  { pattern: /^src\/lib\/matching\//, why: "ATS scoring" },
  { pattern: /^src\/lib\/applications\/worker\.ts$/, why: "the application/browser worker" },
  { pattern: /^src\/lib\/applications\/browser/, why: "the browser worker" },
  { pattern: /^src\/lib\/radar\//, why: "radar discovery" },
];

function repoRelative(absolute: string): string {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
}

function resolveLocal(specifier: string, fromFile: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = path.join(REPO_ROOT, "src", specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else {
    return null;
  }

  if (existsSync(base) && !existsSync(path.join(base, "package.json"))) {
    for (const extension of RESOLVE_EXTENSIONS) {
      if (base.endsWith(extension)) return base;
    }
  }
  for (const extension of RESOLVE_EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (existsSync(candidate)) return candidate;
  }
  for (const extension of RESOLVE_EXTENSIONS) {
    const candidate = path.join(base, `index${extension}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function packageNameOf(specifier: string): string {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0];
}

/** Static imports/exports plus `import(...)` and `require(...)`. */
function importSpecifiers(source: string): string[] {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  const patterns = [
    /(?:^|[\s;}])(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g,
    /(?:^|[\s;}])import\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  const found = new Set<string>();
  for (const pattern of patterns) {
    for (const match of withoutComments.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

type Closure = {
  /** repo-relative local files reachable from the entry, excluding the entry. */
  localFiles: string[];
  /** bare package specifiers reachable from the entry. */
  packages: string[];
  /** how each reachable file was reached, for readable failures. */
  chainTo: Map<string, string[]>;
};

function importClosure(entryRelative: string): Closure {
  const entry = path.join(REPO_ROOT, entryRelative);
  const seen = new Set<string>([entry]);
  const chainTo = new Map<string, string[]>([[repoRelative(entry), [entryRelative]]]);
  const packages = new Map<string, string[]>();
  const queue: string[] = [entry];
  const localFiles: string[] = [];

  while (queue.length > 0) {
    const file = queue.shift() as string;
    const chain = chainTo.get(repoRelative(file)) ?? [repoRelative(file)];
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    for (const specifier of importSpecifiers(source)) {
      if (specifier.startsWith("node:")) continue;

      const resolved = resolveLocal(specifier, file);
      if (!resolved) {
        const name = packageNameOf(specifier);
        if (!packages.has(name)) packages.set(name, [...chain, name]);
        continue;
      }
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      const relative = repoRelative(resolved);
      chainTo.set(relative, [...chain, relative]);
      localFiles.push(relative);
      queue.push(resolved);
    }
  }

  for (const [name, chain] of packages) chainTo.set(name, chain);
  return { localFiles, packages: [...packages.keys()], chainTo };
}

describe("Next instrumentation never bundles the scheduler again", () => {
  const closure = importClosure(ENTRY);
  const describeChain = (key: string) => (closure.chainTo.get(key) ?? [key]).join("\n    -> ");

  it("resolves its own import graph (the walker itself must work)", () => {
    // A walker that silently resolves nothing would pass every assertion
    // below. Prove it can actually follow a real chain in this repository.
    const proof = importClosure("src/lib/sync/scheduler.ts");
    expect(proof.localFiles).toContain("src/lib/db.ts");
    expect(proof.packages).toContain("@prisma/adapter-pg");
  });

  it("does not import the scheduler, Prisma, pg, discovery, scoring, Gmail, or the browser worker", () => {
    for (const file of closure.localFiles) {
      for (const { pattern, why } of FORBIDDEN_LOCAL_MODULES) {
        expect(
          pattern.test(file),
          `src/instrumentation.ts must not reach ${why} (${file}):\n    ${describeChain(file)}`,
        ).toBe(false);
      }
    }
  });

  it("does not pull a package that resolves Node built-ins through the bundler", () => {
    for (const name of closure.packages) {
      expect(
        FORBIDDEN_PACKAGES.includes(name),
        `src/instrumentation.ts must not reach ${name}:\n    ${describeChain(name)}`,
      ).toBe(false);
    }
  });

  it("stays small enough that the closure can be reasoned about", () => {
    // Not a style rule: every module added here is compiled into Next's
    // instrumentation bundle on Windows Webpack. A closure that grows past a
    // handful of files is how the pg chain got in the first time.
    expect(closure.localFiles.length).toBeLessThanOrEqual(5);
  });

  it("still documents why the scheduler lives outside the web process", () => {
    const source = readFileSync(path.join(REPO_ROOT, ENTRY), "utf8");
    expect(source).toMatch(/scheduler-worker/);
    expect(source).not.toMatch(/startScheduler\s*\(/);
  });
});
