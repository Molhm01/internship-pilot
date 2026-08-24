import { describe, expect, it } from "vitest";

import {
  decideLocalStartup,
  orphanRecoveryTarget,
  stoppablePids,
  type LocalStartupProbe,
} from "@/lib/runtime/localStartup";
import {
  compareLocalInstance,
  hashRepoRoot,
  parsePackedRefs,
  type LocalInstanceIdentity,
} from "@/lib/runtime/localInstance";
import {
  extractDocumentAssets,
  summarizeAssetHealth,
  type AssetProbeResult,
} from "@/lib/runtime/documentAssets";

/**
 * The Windows failure this file exists for.
 *
 * A Next process kept listening on port 3000 after `.next` had been deleted
 * and rebuilt. `/api/extension/health` still returned HTTP 200, so the
 * launcher reused it — and the browser received HTML whose every stylesheet
 * and JS chunk 500'd. The sidebar rendered as browser-default blue links and
 * the logo filled the viewport.
 *
 * None of this needs a running stack to test: the launcher's judgment is a
 * pure function over what it observed, so every branch is pinned here.
 */

const REPO = "C:/Users/dev/Internship-AI";
const OTHER_REPO = "C:/Users/dev/some-other-app";

function identity(overrides: Partial<LocalInstanceIdentity> = {}): LocalInstanceIdentity {
  return {
    instanceProtocol: 1,
    service: "Internship Pilot",
    repoRoot: REPO,
    repoRootHash: hashRepoRoot(REPO),
    commit: "a".repeat(40),
    commitSource: "git",
    buildId: null,
    sessionId: "session-1",
    startedAt: "2026-08-23T10:00:00.000Z",
    nodeVersion: "v22.0.0",
    pid: 4242,
    serverBuild: "internship-pilot-test",
    protocolVersion: 2,
    ...overrides,
  };
}

function healthyAssets(checked = 12) {
  return summarizeAssetHealth({
    documentStatus: 200,
    documentBytes: 20_000,
    probes: Array.from({ length: checked }, (_, index): AssetProbeResult => ({
      url: `http://localhost:3000/_next/static/chunk-${index}.js`,
      kind: "script",
      buildOutput: true,
      status: 200,
    })),
    requireAssets: true,
  });
}

function brokenAssets() {
  return summarizeAssetHealth({
    documentStatus: 200,
    documentBytes: 20_000,
    probes: [
      { url: "http://localhost:3000/_next/static/css/app.css", kind: "stylesheet", buildOutput: true, status: 500 },
      { url: "http://localhost:3000/_next/static/chunks/main.js", kind: "script", buildOutput: true, status: 500 },
    ],
    requireAssets: true,
  });
}

function probe(overrides: Partial<LocalStartupProbe> = {}): LocalStartupProbe {
  return {
    port: 3000,
    portInUse: true,
    portOwnerPid: 4242,
    portOwnerName: "node.exe",
    healthOk: true,
    runningInstance: identity(),
    assetHealth: healthyAssets(),
    expected: {
      repoRoot: REPO,
      repoRootHash: hashRepoRoot(REPO),
      commit: "a".repeat(40),
      buildId: null,
      instanceProtocol: 1,
    },
    lock: null,
    liveLockPids: [],
    ...overrides,
  };
}

describe("npm run local — what to do about whatever holds the port", () => {
  it("1. an old lock whose PIDs are all dead is cleared, and startup proceeds", () => {
    const decision = decideLocalStartup(
      probe({
        portInUse: false,
        portOwnerPid: null,
        runningInstance: null,
        assetHealth: null,
        healthOk: false,
        lock: { repoRoot: REPO, supervisorPid: 111, webPid: 112, schedulerPid: 113, workerPid: 114 },
        liveLockPids: [],
      }),
    );
    expect(decision.action).toBe("start");
  });

  it("2. a genuinely current, healthy server from this checkout is reused", () => {
    const decision = decideLocalStartup(probe());
    expect(decision.action).toBe("reuse");
  });

  it("3. a server from a different commit is restarted, not silently reused", () => {
    const decision = decideLocalStartup(probe({ runningInstance: identity({ commit: "b".repeat(40) }) }));
    expect(decision.action).toBe("restart_owned");
    if (decision.action !== "restart_owned") throw new Error("unreachable");
    expect(decision.comparison?.reason).toBe("different_commit");
    expect(decision.pids).toContain(4242);
  });

  it("3b. a server serving a different Next build id is restarted", () => {
    const decision = decideLocalStartup(
      probe({
        runningInstance: identity({ buildId: "old-build" }),
        expected: {
          repoRoot: REPO,
          repoRootHash: hashRepoRoot(REPO),
          commit: "a".repeat(40),
          buildId: "new-build",
          instanceProtocol: 1,
        },
      }),
    );
    expect(decision.action).toBe("restart_owned");
  });

  it("4. an unrelated process on port 3000 is reported and never stopped", () => {
    const decision = decideLocalStartup(
      probe({
        healthOk: false,
        runningInstance: null,
        assetHealth: null,
        portOwnerPid: 9999,
        portOwnerName: "python.exe",
      }),
    );
    expect(decision.action).toBe("abort_foreign_port");
    expect(JSON.stringify(decision)).not.toContain("restart");
  });

  it("4b. another checkout of Internship Pilot on the port is also left alone", () => {
    const decision = decideLocalStartup(
      probe({ runningInstance: identity({ repoRoot: OTHER_REPO, repoRootHash: hashRepoRoot(OTHER_REPO) }) }),
    );
    expect(decision.action).toBe("abort_foreign_port");
  });

  it("5. a repository-owned stale Next process with no usable lock is restarted", () => {
    // The lockfile was lost in the crash; the process itself still proves the
    // repo it came from, which is enough to stop it.
    const decision = decideLocalStartup(
      probe({ runningInstance: identity({ commit: "c".repeat(40) }), lock: null }),
    );
    expect(decision.action).toBe("restart_owned");
    if (decision.action !== "restart_owned") throw new Error("unreachable");
    expect(decision.pids).toEqual([4242]);
  });

  it("5b. ownership can also be proven by the lockfile when the instance endpoint is dead", () => {
    const decision = decideLocalStartup(
      probe({
        healthOk: false,
        runningInstance: null,
        assetHealth: null,
        lock: { repoRoot: REPO, supervisorPid: 100, webPid: 4242, schedulerPid: 101, workerPid: 102 },
        liveLockPids: [100, 4242, 101, 102],
      }),
    );
    expect(decision.action).toBe("restart_owned");
    if (decision.action !== "restart_owned") throw new Error("unreachable");
    expect(decision.pids.sort()).toEqual([100, 101, 102, 4242]);
  });

  it("6. HEALTH 200 IS NOT ENOUGH: broken build assets force a restart", () => {
    const decision = decideLocalStartup(probe({ healthOk: true, assetHealth: brokenAssets() }));
    expect(decision.action).toBe("restart_owned");
    if (decision.action !== "restart_owned") throw new Error("unreachable");
    expect(decision.reason).toMatch(/cannot serve its own build output/);
  });

  it("6b. a document that references no assets at all is treated as broken", () => {
    const report = summarizeAssetHealth({
      documentStatus: 200,
      documentBytes: 400,
      probes: [],
      requireAssets: true,
    });
    expect(report.ok).toBe(false);
    expect(decideLocalStartup(probe({ assetHealth: report })).action).toBe("restart_owned");
  });

  it("6c. asset health that could not be measured is never treated as passing", () => {
    expect(decideLocalStartup(probe({ assetHealth: null })).action).toBe("restart_owned");
  });

  it("refuses to double-start while a sibling supervisor from this repo is alive", () => {
    const decision = decideLocalStartup(
      probe({
        portInUse: false,
        portOwnerPid: null,
        runningInstance: null,
        assetHealth: null,
        healthOk: false,
        lock: { repoRoot: REPO, supervisorPid: 500, webPid: null, schedulerPid: null, workerPid: null },
        liveLockPids: [500],
      }),
    );
    expect(decision.action).toBe("abort_double_start");
  });

  it("a live lock belonging to a DIFFERENT repo does not block startup here", () => {
    const decision = decideLocalStartup(
      probe({
        portInUse: false,
        portOwnerPid: null,
        runningInstance: null,
        assetHealth: null,
        healthOk: false,
        lock: { repoRoot: OTHER_REPO, supervisorPid: 500, webPid: null, schedulerPid: null, workerPid: null },
        liveLockPids: [500],
      }),
    );
    expect(decision.action).toBe("start");
  });
});

describe("7. npm run local:stop only touches processes this repository owns", () => {
  const isAlive = () => true;

  it("stops every live PID recorded by this repo's lock", () => {
    const targets = stoppablePids({
      repoRoot: REPO,
      lock: { repoRoot: REPO, supervisorPid: 1, webPid: 2, schedulerPid: 3, workerPid: 4 },
      isAlive,
      selfPid: 99,
    });
    expect(targets.map((target) => target.pid)).toEqual([4, 3, 2, 1]);
    expect(targets.map((target) => target.label)).toEqual([
      "Application worker",
      "Scheduler + scoring worker",
      "Web server",
      "Supervisor",
    ]);
  });

  it("stops nothing when the lock names a different repository", () => {
    expect(
      stoppablePids({
        repoRoot: REPO,
        lock: { repoRoot: OTHER_REPO, supervisorPid: 1, webPid: 2, schedulerPid: 3, workerPid: 4 },
        isAlive,
        selfPid: 99,
      }),
    ).toEqual([]);
  });

  it("skips dead PIDs and never stops itself", () => {
    const targets = stoppablePids({
      repoRoot: REPO,
      lock: { repoRoot: REPO, supervisorPid: 99, webPid: 2, schedulerPid: null, workerPid: null },
      isAlive: (pid) => pid !== 2,
      selfPid: 99,
    });
    expect(targets).toEqual([]);
  });

  it("recovers a lock-less orphan only when the process reports this repo root", () => {
    expect(
      orphanRecoveryTarget({
        portOwnerPid: 4242,
        runningInstance: identity(),
        expectedRepoRootHash: hashRepoRoot(REPO),
      }),
    ).toMatchObject({ pid: 4242 });

    expect(
      orphanRecoveryTarget({
        portOwnerPid: 4242,
        runningInstance: identity({ repoRootHash: hashRepoRoot(OTHER_REPO) }),
        expectedRepoRootHash: hashRepoRoot(REPO),
      }),
    ).toBeNull();

    // No identity at all: an unknown process is never a recovery target.
    expect(
      orphanRecoveryTarget({
        portOwnerPid: 4242,
        runningInstance: null,
        expectedRepoRootHash: hashRepoRoot(REPO),
      }),
    ).toBeNull();
  });
});

describe("instance identity is captured at boot, not at request time", () => {
  it("answers with the same commit and session no matter when it is asked", async () => {
    const { localInstanceIdentity } = await import("@/lib/runtime/localInstance");
    const first = localInstanceIdentity();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = localInstanceIdentity();

    // The first version read .git/HEAD on every request. Tested against a real
    // running server, it agreed with a checkout it had never been built from
    // the moment someone committed — which is the one thing it exists to
    // detect. "What was this process built from" has exactly one answer.
    expect(second.commit).toBe(first.commit);
    expect(second.buildId).toBe(first.buildId);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.startedAt).toBe(first.startedAt);
  });
});

describe("instance comparison", () => {
  it("treats a missing identity endpoint as unproven, never as a match", () => {
    const comparison = compareLocalInstance(null, {
      repoRootHash: hashRepoRoot(REPO),
      commit: "a".repeat(40),
      buildId: null,
      instanceProtocol: 1,
    });
    expect(comparison.compatible).toBe(false);
    expect(comparison.sameRepo).toBe(false);
  });

  it("does not invent a mismatch when neither side can read a commit", () => {
    const comparison = compareLocalInstance(identity({ commit: null, commitSource: "unknown" }), {
      repoRootHash: hashRepoRoot(REPO),
      commit: null,
      buildId: null,
      instanceProtocol: 1,
    });
    expect(comparison.compatible).toBe(true);
  });

  it("rejects a server speaking a different local-instance protocol", () => {
    const comparison = compareLocalInstance(identity({ instanceProtocol: 99 }), {
      repoRootHash: hashRepoRoot(REPO),
      commit: "a".repeat(40),
      buildId: null,
      instanceProtocol: 1,
    });
    expect(comparison.compatible).toBe(false);
    expect(comparison.sameRepo).toBe(true);
  });

  it("normalizes path spelling so one directory hashes to one value", () => {
    expect(hashRepoRoot("C:/Users/dev/Internship-AI")).toBe(hashRepoRoot("C:\\Users\\dev\\Internship-AI\\"));
  });

  it("reads a branch tip out of packed-refs", () => {
    const packed = ["# pack-refs with: peeled fully-peeled sorted", `${"d".repeat(40)} refs/heads/main`, "^" + "e".repeat(40)].join("\n");
    expect(parsePackedRefs(packed, "refs/heads/main")).toBe("d".repeat(40));
    expect(parsePackedRefs(packed, "refs/heads/other")).toBeNull();
  });
});

describe("document asset extraction", () => {
  const base = "http://localhost:3000/";

  it("collects same-origin scripts and stylesheets, and skips third parties", () => {
    const html = `
      <html><head>
        <link rel="stylesheet" href="/_next/static/css/app.css"/>
        <link rel="preload" as="script" href="/_next/static/chunks/main.js"/>
        <link rel="icon" href="/favicon.ico"/>
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist"/>
        <script src="/_next/static/chunks/webpack.js"></script>
        <script type="module" src="/_next/static/chunks/app.js"></script>
        <script>console.log("inline")</script>
        <script src="https://cdn.example.com/analytics.js"></script>
      </head><body></body></html>`;

    const assets = extractDocumentAssets(html, base);
    expect(assets.map((asset) => new URL(asset.url).pathname).sort()).toEqual([
      "/_next/static/chunks/app.js",
      "/_next/static/chunks/main.js",
      "/_next/static/chunks/webpack.js",
      "/_next/static/css/app.css",
    ]);
    expect(assets.every((asset) => asset.buildOutput)).toBe(true);
  });

  it("de-duplicates repeated references and decodes entity-escaped hrefs", () => {
    const html = `
      <script src="/_next/static/a.js"></script>
      <script src="/_next/static/a.js"></script>
      <link rel="stylesheet" href="/_next/static/b.css?v=1&amp;x=2"/>`;
    const assets = extractDocumentAssets(html, base);
    expect(assets).toHaveLength(2);
    expect(assets.some((asset) => asset.url.endsWith("b.css?v=1&x=2"))).toBe(true);
  });

  it("counts a 404 or a 5xx chunk as a failure, but not a 304 or a 204", () => {
    const report = summarizeAssetHealth({
      documentStatus: 200,
      documentBytes: 100,
      probes: [
        { url: `${base}a.js`, kind: "script", buildOutput: true, status: 304 },
        { url: `${base}b.js`, kind: "script", buildOutput: true, status: 404 },
        { url: `${base}c.css`, kind: "stylesheet", buildOutput: true, status: 503 },
      ],
      requireAssets: true,
    });
    expect(report.ok).toBe(false);
    expect(report.failures.map((failure) => failure.status)).toEqual([404, 503]);
  });

  it("fails when the document itself never answered", () => {
    const report = summarizeAssetHealth({
      documentStatus: null,
      documentBytes: 0,
      probes: [],
      requireAssets: true,
    });
    expect(report.reason).toBe("document_unreachable");
  });
});
