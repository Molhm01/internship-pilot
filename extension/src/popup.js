"use strict";

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "No response from the extension service worker." });
    });
  });
}

async function refresh() {
  const response = await send({ kind: "health" });
  const title = document.getElementById("status-title");
  const detail = document.getElementById("status-detail");
  const dot = document.getElementById("status-dot");
  const versions = document.getElementById("versions");

  const extV = response.extensionVersion || chrome.runtime.getManifest().version;
  const extProto = response.extensionProtocolVersion;
  const srvProto = response.serverProtocolVersion;
  const srvBuild = response.serverBuild;
  if (versions) {
    versions.textContent = response.ok
      ? `Extension v${extV} (protocol ${extProto}) · Server ${srvBuild || "?"} (protocol ${srvProto ?? "?"})`
      : `Extension v${extV} (protocol ${extProto}) · Server not reachable`;
  }

  const incompatible = response.ok && response.compatible === false;
  if (incompatible) {
    title.textContent = "Version mismatch — do not autofill";
    detail.textContent = `The local app speaks protocol ${srvProto ?? "?"} but this extension speaks ${extProto}. Rebuild the extension (npm run extension:build) and reload it, or restart the app.`;
    dot.classList.remove("connected");
  } else if (response.ok && response.authenticated) {
    title.textContent = "Connected and ready";
    detail.textContent = `${response.base} · FILL_TO_SUBMIT · Submit disabled`;
    dot.classList.add("connected");
  } else if (response.ok) {
    title.textContent = "Local app found — token needed";
    detail.textContent = `${response.base} · Enter the local extension token below`;
    dot.classList.remove("connected");
  } else {
    title.textContent = "Local app is not reachable";
    detail.textContent = "Start Internship Pilot, then connect again.";
    dot.classList.remove("connected");
  }
}

document.getElementById("connection-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = document.getElementById("form-message");
  const response = await send({
    kind: "save-settings",
    backendBaseUrl: document.getElementById("backend").value,
    apiToken: document.getElementById("token").value,
  });
  message.textContent = response.ok ? "Connection settings saved locally." : response.error || "Connection failed.";
  if (response.ok) {
    document.getElementById("token").value = "";
    await refresh();
  }
});

void refresh();
