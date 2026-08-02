import path from "node:path";
import { readFile } from "node:fs/promises";
import { EXTENSION_PROTOCOL_VERSION } from "@/lib/applications/extensionProtocol";

const dist = path.resolve(process.cwd(), "extension", "dist");
const required = [
  "manifest.json",
  "background.js",
  "page-reader.js",
  "content.js",
  "content.css",
  "popup.html",
  "popup.css",
  "popup.js",
];

async function main(): Promise<void> {
  const files = await Promise.all(required.map(async (filename) => ({
    filename,
    content: await readFile(path.join(dist, filename), "utf8"),
  })));
  const manifest = JSON.parse(files.find((file) => file.filename === "manifest.json")?.content ?? "{}") as {
    manifest_version?: number;
    background?: { service_worker?: string };
    content_scripts?: Array<{ js?: string[]; css?: string[] }>;
  };
  if (manifest.manifest_version !== 3) throw new Error("Extension manifest must use Manifest V3.");
  if (manifest.background?.service_worker !== "background.js") throw new Error("Manifest V3 background service worker is missing.");
  if (!manifest.content_scripts?.[0]?.js?.includes("content.js")) throw new Error("Static content script is missing.");
  if (!manifest.content_scripts?.[0]?.js?.includes("page-reader.js")) throw new Error("Read-only job-description content script is missing.");
  if (!manifest.content_scripts?.[0]?.css?.includes("content.css")) throw new Error("Content-script styling is missing.");
  const combined = files.map((file) => file.content).join("\n");
  if (/<script[^>]+src=["']https?:/i.test(combined) || /\bimportScripts\s*\(\s*["']https?:/i.test(combined)) {
    throw new Error("Remote extension code is forbidden.");
  }
  if (!combined.includes('data-internship-pilot-action", "autofill"')) {
    throw new Error("Required in-page autofill action attribute is missing.");
  }
  // Guard against server/extension protocol drift: the number baked into
  // background.js MUST equal the server's EXTENSION_PROTOCOL_VERSION.
  const background = files.find((file) => file.filename === "background.js")?.content ?? "";
  const declared = background.match(/EXTENSION_PROTOCOL_VERSION\s*=\s*(\d+)/);
  if (!declared) throw new Error("background.js must declare EXTENSION_PROTOCOL_VERSION.");
  if (Number(declared[1]) !== EXTENSION_PROTOCOL_VERSION) {
    throw new Error(
      `Protocol drift: background.js declares v${declared[1]} but the server speaks v${EXTENSION_PROTOCOL_VERSION}. ` +
        "Update both together (extension/dist/background.js and src/lib/applications/extensionProtocol.ts).",
    );
  }
  console.log(`Manifest V3 extension package validated: ${dist}`);
  console.log(`Protocol version: ${EXTENSION_PROTOCOL_VERSION} (extension and server agree).`);
  console.log(`Assets: ${required.join(", ")}`);
}

void main();
