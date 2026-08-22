import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
if (packageJson.dependencies?.prisma) {
  console.error("FAIL: prisma CLI must not be a production dependency.");
  process.exit(1);
}
if (!packageJson.devDependencies?.prisma) {
  console.error("FAIL: prisma CLI must remain an explicit development dependency for generate/migrate tooling.");
  process.exit(1);
}

const audit = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["audit", "--omit=dev", "--omit=peer", "--json"],
  { encoding: "utf8", cwd: new URL("..", import.meta.url) },
);

let report;
try {
  report = JSON.parse(audit.stdout || "{}");
} catch (error) {
  console.error("FAIL: npm audit did not return parseable JSON.");
  if (audit.stdout) console.error(audit.stdout.slice(0, 4000));
  if (audit.stderr) console.error(audit.stderr.slice(0, 4000));
  process.exit(1);
}

if (report.error) {
  console.error(`FAIL: npm audit itself failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
  process.exit(1);
}

const vulnerabilities = report.vulnerabilities ?? {};
const releaseBlocking = [];
const cliOnlyAllowed = [];

// npm 10 currently inventories Prisma's optional peer even with both
// `--omit=dev` and `--omit=peer`. The package-lock correctly marks `prisma`
// devOptional because @prisma/client declares it as an optional peer. None of
// this CLI/config code is imported or bundled by the running Internship Pilot
// server. Keep the exception deliberately tiny and structural: only this exact
// known toolchain can be non-blocking; every other high/critical finding fails.
const PRISMA_CLI_ONLY = new Set(["prisma", "@prisma/config", "deepmerge-ts"]);

for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
  if (!vulnerability || !["high", "critical"].includes(vulnerability.severity)) continue;

  const effectNames = Array.isArray(vulnerability.effects) ? vulnerability.effects : [];
  const isKnownCliOnly =
    PRISMA_CLI_ONLY.has(name) &&
    !vulnerability.isDirect &&
    effectNames.every((effect) => PRISMA_CLI_ONLY.has(effect));

  // `prisma` itself can be reported as the top of the chain. It is direct only
  // as a devDependency, which npm's JSON does not distinguish from a runtime
  // direct dependency. package.json was checked above, so it is safe to allow
  // that one package name while still rejecting every unrelated direct issue.
  const isPrismaDevRoot = name === "prisma" && !packageJson.dependencies?.prisma;

  if (isKnownCliOnly || isPrismaDevRoot) {
    cliOnlyAllowed.push({ name, severity: vulnerability.severity, effects: effectNames });
  } else {
    releaseBlocking.push({
      name,
      severity: vulnerability.severity,
      direct: Boolean(vulnerability.isDirect),
      effects: effectNames,
      via: Array.isArray(vulnerability.via)
        ? vulnerability.via.map((item) => typeof item === "string" ? item : item?.title ?? item?.name ?? "unknown")
        : [],
    });
  }
}

if (releaseBlocking.length > 0) {
  console.error("FAIL: production dependency audit found release-blocking high/critical vulnerabilities:");
  console.error(JSON.stringify(releaseBlocking, null, 2));
  process.exit(1);
}

console.log("PASS: no high/critical vulnerabilities were found in the deployable application runtime dependency graph.");
if (cliOnlyAllowed.length > 0) {
  console.log("INFO: npm also reported the following Prisma CLI-only advisory chain; it is development/optional-peer tooling and is not part of the deployed server runtime:");
  console.log(JSON.stringify(cliOnlyAllowed, null, 2));
}
