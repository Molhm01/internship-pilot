import { readFile } from "node:fs/promises";

/**
 * The structural half of the production dependency gate.
 *
 * `npm audit --omit=dev --audit-level=high` runs alongside this and is the
 * gate on *known advisories*. What it cannot check is dependency architecture:
 * a package can be advisory-free today and still have no business in the
 * deployed runtime, and the way that goes wrong is silently — someone runs
 * `npm install prisma` without `-D` and the whole CLI toolchain, its embedded
 * dev server and its HTTP stack join the production tree.
 *
 * This asserts the placements that are decisions rather than accidents.
 *
 * ## No advisory allowlist
 *
 * An earlier version of this script excused the Prisma CLI advisory chain
 * (`prisma` → `@prisma/config` → `deepmerge-ts`) as unreachable from the
 * server. That reasoning was sound, but the exception is no longer needed:
 * `deepmerge-ts` has a patched major, and the `overrides` block in package.json
 * pins it, so the plain audit reports zero high/critical findings with nothing
 * suppressed. Keeping an allowlist that currently matches nothing would only
 * create somewhere for a future advisory to hide.
 */

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const dependencies = packageJson.dependencies ?? {};
const devDependencies = packageJson.devDependencies ?? {};

const failures = [];

/** Build/ops tooling that must never be reachable from the deployed server. */
const BUILD_ONLY = [
  ["prisma", "the Prisma CLI: schema, generate and migrate tooling. The server imports @prisma/client, never this."],
  ["@libsql/client", "the SQLite driver, kept only for the one-shot SQLite-to-PostgreSQL import utility."],
  ["@prisma/adapter-libsql", "the retired SQLite Prisma adapter."],
  ["pdf-lib", "a fixture-only PDF writer used to build test documents."],
];

for (const [name, why] of BUILD_ONLY) {
  if (dependencies[name]) {
    failures.push(`${name} must not be a production dependency — ${why}`);
  }
}

if (!devDependencies.prisma) {
  failures.push("prisma must remain an explicit devDependency: generate and migrate run at build time.");
}

/** Imported by server code, so these belong in the runtime tree. */
const RUNTIME_REQUIRED = [
  ["@prisma/client", "the query client every server module imports."],
  ["@prisma/adapter-pg", "the PostgreSQL driver adapter src/lib/db.ts constructs."],
  ["pg", "the connection pool that adapter drives."],
];

for (const [name, why] of RUNTIME_REQUIRED) {
  if (!dependencies[name]) {
    failures.push(`${name} must stay a production dependency — ${why}`);
  }
}

if (failures.length > 0) {
  console.error("FAIL: production dependency architecture gate");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("PASS: build-only tooling is out of the production dependency tree, and every runtime driver is in it.");
