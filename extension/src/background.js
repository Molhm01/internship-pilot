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

function errorText(error) {
  return String(error && error.message ? error.message : error);
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
