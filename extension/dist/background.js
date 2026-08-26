// Internship Pilot Autofill — Manifest V3 background service worker.
//
// The backend is the Internship Pilot WEBSITE, which may be running on this
// computer (http://localhost:3000) or hosted (https://…). Both are accepted:
// loopback over http, because that is where a local install lives, and any
// origin over https, because that is the only way a deployed website can be
// reached at all. Plain http to a non-loopback host is refused — the API token
// travels on every request and must never cross a network in the clear.
//
// The local Internship Agent is a separate thing entirely and is never
// contacted from here.

"use strict";

const DEFAULT_BACKENDS = ["http://localhost:3000", "http://127.0.0.1:3000"];
// Mirrors EXTENSION_PROTOCOL_VERSION in src/lib/applications/extensionProtocol.ts.
// Bump together with the server when the message shapes change.
const EXTENSION_PROTOCOL_VERSION = 2;
let cachedBase = null;
let cachedHealth = null;
const BUNDLE_STORAGE_KEY = "pendingApplicationBundle";
const APPLICATION_STATES = new Set([
  "QUEUED", "PREPARING_DOCUMENTS", "DOCUMENTS_READY", "OPENING", "SCANNING",
  "FILLING", "VALIDATING", "AWAITING_USER", "NAVIGATING", "REVIEW_READY",
  "BLOCKED", "FAILED",
]);

function errorText(error) {
  return String(error && error.message ? error.message : error);
}

function bundleStorage() {
  return chrome.storage.session || chrome.storage.local;
}

function safeTransitionMetadata(value) {
  if (!value || typeof value !== "object") return {};
  const source = value;
  return {
    ...(typeof source.pageNumber === "number" ? { pageNumber: source.pageNumber } : {}),
    ...(typeof source.filledCount === "number" ? { filledCount: source.filledCount } : {}),
    ...(typeof source.failedCount === "number" ? { failedCount: source.failedCount } : {}),
    ...(typeof source.requiredEmptyCount === "number" ? { requiredEmptyCount: source.requiredEmptyCount } : {}),
    ...(typeof source.uploadedCount === "number" ? { uploadedCount: source.uploadedCount } : {}),
    ...(Array.isArray(source.questionCategories) ? { questionCategories: source.questionCategories.filter((value) => typeof value === "string").slice(0, 100) } : {}),
    ...(Array.isArray(source.unresolvedCategories) ? { unresolvedCategories: source.unresolvedCategories.filter((value) => typeof value === "string").slice(0, 100) } : {}),
    ...(typeof source.errorCode === "string" ? { errorCode: source.errorCode.slice(0, 100) } : {}),
  };
}

function validateApplicationBundle(bundle) {
  if (!bundle || typeof bundle !== "object") return "The application bundle is missing.";
  if (typeof bundle.websiteJobId !== "string" || !bundle.websiteJobId) return "The bundle has no website job id.";
  if (typeof bundle.officialApplicationUrl !== "string") return "The bundle has no official application URL.";
  try {
    const destination = new URL(bundle.officialApplicationUrl);
    if (destination.protocol !== "https:" && !(destination.protocol === "http:" && ["localhost", "127.0.0.1"].includes(destination.hostname))) {
      return "The employer destination is not a safe application URL.";
    }
  } catch {
    return "The employer destination is invalid.";
  }
  if (typeof bundle.documentFingerprint !== "string" || !/^[a-f0-9]{64}$/i.test(bundle.documentFingerprint)) {
    return "The application document fingerprint is missing or invalid.";
  }
  if (!bundle.profile || typeof bundle.profile !== "object") return "The canonical application profile is missing.";
  if (bundle.bundleVersion !== 3 || bundle.profile.version !== 3) return "The website and extension application-bundle versions do not match.";
  if (!Array.isArray(bundle.documents)) return "The application documents are missing.";
  const resume = bundle.documents.filter((document) => document && document.kind === "resume");
  if (resume.length !== 1) return "The bundle must contain exactly one tailored résumé.";
  for (const document of bundle.documents) {
    if (!document || document.websiteJobId !== bundle.websiteJobId) return "A document belongs to another job.";
    if (document.documentFingerprint !== bundle.documentFingerprint) return "A document is stale or belongs to another application.";
    if (document.qaStatus !== "pass" || document.identityVerified !== true) return "A document did not pass QA and identity verification.";
    if (document.mimeType !== "application/pdf" || typeof document.contentBase64 !== "string" || document.contentBase64.length === 0) {
      return "A prepared application document is incomplete.";
    }
    if (!Number.isSafeInteger(document.byteLength) || document.byteLength <= 0) return "A document has an invalid byte length.";
  }
  return null;
}

function sameApplication(bundleUrl, pageUrl) {
  try {
    const expected = new URL(bundleUrl);
    const current = new URL(pageUrl);
    if (expected.origin !== current.origin) return false;
    const expectedPath = expected.pathname.replace(/\/+$/, "");
    const currentPath = current.pathname.replace(/\/+$/, "");
    return currentPath === expectedPath
      || currentPath.startsWith(`${expectedPath}/`)
      || expectedPath.startsWith(`${currentPath}/`);
  } catch {
    return false;
  }
}

async function storedBundle() {
  const stored = await bundleStorage().get(BUNDLE_STORAGE_KEY);
  return stored[BUNDLE_STORAGE_KEY] || null;
}

async function transitionBundle(state, reason, pageUrl, metadata = {}) {
  if (!APPLICATION_STATES.has(state)) throw new Error(`Unknown application state ${state}.`);
  const envelope = await storedBundle();
  if (!envelope) return null;
  const transition = {
    state,
    at: new Date().toISOString(),
    reason: String(reason || "State updated.").slice(0, 400),
    pageUrl: String(pageUrl || "").slice(0, 2_000),
    metadata: safeTransitionMetadata(metadata),
  };
  const updated = {
    ...envelope,
    state,
    pageNumber: typeof metadata.pageNumber === "number" ? metadata.pageNumber : envelope.pageNumber,
    transitions: [...(envelope.transitions || []), transition].slice(-100),
    updatedAt: transition.at,
  };
  await bundleStorage().set({ [BUNDLE_STORAGE_KEY]: updated });
  return updated;
}

function isLoopbackBase(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:"
      && (url.hostname === "localhost" || url.hostname === "127.0.0.1")
      && url.pathname === "/";
  } catch {
    return false;
  }
}

/** An https origin, i.e. a deployed Internship Pilot. */
function isSecureRemoteBase(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0 && url.pathname === "/";
  } catch {
    return false;
  }
}

/** Every backend this extension is willing to send the API token to. */
function isAllowedBase(value) {
  return isLoopbackBase(value) || isSecureRemoteBase(value);
}

function allowedSender(sender, popupAllowed) {
  if (sender.tab && /^https?:\/\//i.test(sender.tab.url || sender.url || "")) return true;
  return Boolean(
    popupAllowed
    && !sender.tab
    && sender.url
    && sender.url.startsWith(chrome.runtime.getURL("")),
  );
}

async function settings() {
  return chrome.storage.local.get(["apiToken", "backendBaseUrl"]);
}

async function backendCandidates() {
  const stored = await settings();
  const custom = typeof stored.backendBaseUrl === "string"
    ? stored.backendBaseUrl.trim().replace(/\/+$/, "")
    : "";
  // A configured backend wins. The localhost defaults stay as a fallback so a
  // purely local install still works with nothing entered in the popup.
  return [
    ...(isAllowedBase(`${custom}/`) ? [custom] : []),
    ...DEFAULT_BACKENDS,
  ].filter((value, index, values) => values.indexOf(value) === index);
}

async function backendBase() {
  if (cachedBase) return cachedBase;
  for (const base of await backendCandidates()) {
    try {
      const response = await fetch(`${base}/api/extension/health`, { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (response.ok && body && body.ok === true && body.submitEnabled === false) {
        cachedBase = base;
        cachedHealth = body;
        return base;
      }
    } catch {
      // Continue to the next local candidate.
    }
  }
  cachedHealth = null;
  return null;
}

// Re-fetch health from a known base (bypassing the cache) so a server that
// was restarted/updated to an incompatible protocol is detected before the
// next fill instead of trusting a stale cached handshake.
async function refreshHealth(base) {
  try {
    const response = await fetch(`${base}/api/extension/health`, { cache: "no-store" });
    const body = await response.json().catch(() => null);
    if (response.ok && body && body.ok === true) { cachedHealth = body; return body; }
  } catch {
    // Leave cachedHealth as-is; caller handles unreachable base separately.
  }
  return cachedHealth;
}

// Compares the extension's protocol version to the running server's. Returns
// { compatible, serverProtocolVersion, extensionProtocolVersion, serverBuild }.
function protocolCompatibility() {
  const serverProtocolVersion = cachedHealth && typeof cachedHealth.protocolVersion === "number"
    ? cachedHealth.protocolVersion
    : null;
  return {
    compatible: serverProtocolVersion === EXTENSION_PROTOCOL_VERSION,
    serverProtocolVersion,
    extensionProtocolVersion: EXTENSION_PROTOCOL_VERSION,
    serverBuild: cachedHealth && typeof cachedHealth.build === "string" ? cachedHealth.build : null,
    extensionVersion: chrome.runtime.getManifest().version,
  };
}

async function authorizationHeaders() {
  const stored = await settings();
  const token = typeof stored.apiToken === "string" ? stored.apiToken.trim() : "";
  if (!token) return null;
  return { Authorization: `Bearer ${token}` };
}

async function authenticated(base) {
  const auth = await authorizationHeaders();
  if (!base || !auth) return false;
  try {
    const response = await fetch(`${base}/api/extension/profile`, {
      cache: "no-store",
      headers: auth,
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function proxyJson(path, init = {}) {
  const [base, auth] = await Promise.all([backendBase(), authorizationHeaders()]);
  if (!base) {
    return { ok: false, status: 0, error: "Internship Pilot is not reachable on this computer." };
  }
  if (!auth) {
    return { ok: false, status: 401, error: "Connect the extension with the local API token first." };
  }
  try {
    const response = await fetch(`${base}${path}`, {
      ...init,
      cache: "no-store",
      headers: {
        ...auth,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });
    const body = await response.json().catch(() => null);
    return {
      ok: response.ok,
      status: response.status,
      body,
      error: response.ok ? null : body?.error || `Internship Pilot returned HTTP ${response.status}.`,
    };
  } catch (error) {
    cachedBase = null;
    return { ok: false, status: 0, error: errorText(error) };
  }
}

async function proxyDocument(documentId, runId) {
  const [base, auth] = await Promise.all([backendBase(), authorizationHeaders()]);
  if (!base) return { ok: false, error: "Internship Pilot is not reachable on this computer." };
  if (!auth) return { ok: false, error: "The extension is not authenticated." };
  try {
    const path = `/api/extension/documents/${encodeURIComponent(documentId)}?runId=${encodeURIComponent(runId)}`;
    const response = await fetch(`${base}${path}`, {
      cache: "no-store",
      headers: auth,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      return { ok: false, status: response.status, error: body?.error || `Document request returned HTTP ${response.status}.` };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const disposition = response.headers.get("content-disposition") || "";
    const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || "document.pdf";
    return {
      ok: true,
      bytes: Array.from(bytes),
      filename,
      contentType: response.headers.get("content-type") || "application/pdf",
    };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    const kind = message && typeof message.kind === "string" ? message.kind : "";
    if (!allowedSender(sender, kind === "health" || kind === "save-settings")) {
      sendResponse({ ok: false, status: 403, error: "This extension request came from an untrusted page." });
      return;
    }
    if (kind === "health") {
      const [base, stored] = await Promise.all([backendBase(), settings()]);
      const tokenPresent = typeof stored.apiToken === "string" && stored.apiToken.trim().length >= 32;
      const compatibility = protocolCompatibility();
      sendResponse({
        ok: Boolean(base),
        base,
        authenticated: tokenPresent && await authenticated(base),
        mode: "FILL_TO_SUBMIT",
        submitEnabled: false,
        ...compatibility,
      });
      return;
    }
    if (kind === "save-settings") {
      const token = typeof message.apiToken === "string" ? message.apiToken.trim() : "";
      const backendBaseUrl = typeof message.backendBaseUrl === "string"
        ? message.backendBaseUrl.trim().replace(/\/+$/, "")
        : DEFAULT_BACKENDS[0];
      if (token.length < 32 || !isAllowedBase(`${backendBaseUrl}/`)) {
        sendResponse({ ok: false, error: "Enter the API token and an Internship Pilot address — either http://localhost:3000 or your hosted https:// site." });
        return;
      }
      await chrome.storage.local.set({ apiToken: token, backendBaseUrl });
      cachedBase = null;
      sendResponse({ ok: true });
      return;
    }
    if (kind === "store-application-bundle") {
      const reason = validateApplicationBundle(message.bundle);
      if (reason) {
        sendResponse({ ok: false, reason });
        return;
      }
      const now = new Date().toISOString();
      const bundleId = `application-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const envelope = {
        bundleId,
        bundle: message.bundle,
        state: "DOCUMENTS_READY",
        pageNumber: 0,
        transitions: [
          { state: "QUEUED", at: now, reason: "Application handoff received.", pageUrl: sender.tab?.url || "", metadata: {} },
          { state: "PREPARING_DOCUMENTS", at: now, reason: message.bundle.documentsReused ? "Document fingerprint matched; current QA-passed files were reused." : "Stale or missing files were regenerated and passed QA.", pageUrl: sender.tab?.url || "", metadata: {} },
          { state: "DOCUMENTS_READY", at: now, reason: "Current QA-passed job documents stored.", pageUrl: sender.tab?.url || "", metadata: {} },
        ],
        createdAt: now,
        updatedAt: now,
      };
      await bundleStorage().set({ [BUNDLE_STORAGE_KEY]: envelope });
      sendResponse({
        ok: true,
        bundleId,
        storedDocuments: message.bundle.documents.map((document) => document.kind),
        storedAt: now,
      });
      return;
    }
    if (kind === "application-bundle-for-page") {
      const envelope = await storedBundle();
      if (!envelope || !sameApplication(envelope.bundle?.officialApplicationUrl, message.pageUrl)) {
        sendResponse({ ok: true, bundle: null });
        return;
      }
      if (["FAILED"].includes(envelope.state)) {
        sendResponse({ ok: true, bundle: null });
        return;
      }
      const updated = await transitionBundle("OPENING", "Official employer application opened.", message.pageUrl, {
        pageNumber: Math.max(1, envelope.pageNumber || 0),
      });
      sendResponse({ ok: true, bundle: updated });
      return;
    }
    if (kind === "application-bundle-transition") {
      const envelope = await storedBundle();
      if (!envelope || envelope.bundleId !== message.bundleId) {
        sendResponse({ ok: false, error: "The application bundle is no longer active." });
        return;
      }
      const updated = await transitionBundle(message.state, message.reason, message.pageUrl, message.metadata);
      sendResponse({ ok: true, state: updated?.state || null });
      return;
    }
    if (kind === "fill-plan") {
      // Confirm the backend is reachable and protocol-compatible BEFORE
      // attempting a fill, so an incompatible server produces a clear
      // message rather than a half-completed run.
      const base = await backendBase();
      if (!base) {
        sendResponse({ ok: false, status: 0, error: "Internship Pilot is not reachable on this computer. Start the local app, then try again." });
        return;
      }
      await refreshHealth(base);
      const compatibility = protocolCompatibility();
      if (!compatibility.compatible) {
        sendResponse({
          ok: false,
          status: 409,
          error: `Version mismatch: extension protocol v${compatibility.extensionProtocolVersion} but the local app speaks v${compatibility.serverProtocolVersion ?? "unknown"} (${compatibility.serverBuild ?? "unknown build"}). Rebuild the extension and reload it, or restart the local app.`,
          ...compatibility,
        });
        return;
      }
      sendResponse(await proxyJson("/api/extension/fill-plan", {
        method: "POST",
        body: JSON.stringify(message.payload),
      }));
      return;
    }
    if (kind === "document") {
      if (!message.documentId || !message.runId) {
        sendResponse({ ok: false, error: "A document and matching ApplicationRun are required." });
        return;
      }
      sendResponse(await proxyDocument(message.documentId, message.runId));
      return;
    }
    if (kind === "report") {
      sendResponse(await proxyJson("/api/extension/report", {
        method: "POST",
        body: JSON.stringify(message.payload),
      }));
      return;
    }
    if (kind === "run-state") {
      sendResponse(await proxyJson(`/api/extension/runs/${encodeURIComponent(message.runId)}`));
      return;
    }
    sendResponse({ ok: false, error: "Unknown extension request." });
  })();
  return true;
});
