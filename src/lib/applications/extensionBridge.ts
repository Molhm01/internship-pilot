/**
 * Website → extension application-bundle handoff.
 *
 * The user clicks "Apply with Application Agent". This module gathers the job
 * context and the tailored PDFs, hands them to the extension over a namespaced
 * `window.postMessage` bridge, waits for the extension to confirm the bytes
 * were stored, and only then opens the employer page.
 *
 * Deliberately absent: any call to /api/application-sessions, any shared auth
 * token, any session identifier in the employer URL, and any request to a
 * local agent server. The website's only job here is to hand over data.
 *
 * No document content ever goes into a URL. The bytes travel inside the message
 * payload, which never leaves this tab.
 */

export const BUNDLE_BRIDGE = {
  probe: "internship-agent:bridge-probe",
  probeAck: "internship-agent:bridge-available",
  offer: "internship-agent:bundle-offer",
  result: "internship-agent:bundle-result",
} as const;

export type BundleDocumentKind = "resume" | "cover_letter";

export type BundleDocumentInput = {
  kind: BundleDocumentKind;
  filename: string;
  mimeType: "application/pdf";
  bytes: ArrayBuffer;
  generatedAt: string;
};

export type ApplicationBundleInput = {
  websiteJobId: string;
  company: string;
  jobTitle: string;
  jobDescription: string;
  officialApplicationUrl: string;
  documents: BundleDocumentInput[];
  /** Canonical profile snapshot from Internship Pilot, the source of truth. */
  profile?: unknown;
  approvedAnswers?: unknown[];
  accountPreferences?: unknown;
  createdAt?: string;
};

export class ExtensionBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionBridgeError";
  }
}

/** How long to wait for the extension to answer. Generous; it writes to disk. */
export const BRIDGE_PROBE_TIMEOUT_MS = 1_500;
export const BRIDGE_TRANSFER_TIMEOUT_MS = 30_000;

function encodeBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  // Chunked so a multi-megabyte PDF cannot exceed the argument limit.
  const chunkSize = 0x8000;
  for (let index = 0; index < view.length; index += chunkSize) {
    binary += String.fromCharCode(...view.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function newRequestId(): string {
  return `bundle-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

type BridgeWindow = Pick<Window, "postMessage" | "addEventListener" | "removeEventListener"> & {
  location: { origin: string };
};

function waitForMessage<T>(
  target: BridgeWindow,
  requestId: string,
  channel: string,
  timeoutMs: number,
  select: (data: Record<string, unknown>) => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      target.removeEventListener("message", listener as EventListener);
      reject(new ExtensionBridgeError(`The Application Agent extension did not answer within ${timeoutMs}ms.`));
    }, timeoutMs);

    const listener = (event: MessageEvent) => {
      const data = event.data as Record<string, unknown> | null;
      if (!data || typeof data !== "object") return;
      if (data.channel !== channel || data.requestId !== requestId) return;
      clearTimeout(timer);
      target.removeEventListener("message", listener as EventListener);
      try {
        resolve(select(data));
      } catch (error) {
        reject(error instanceof Error ? error : new ExtensionBridgeError(String(error)));
      }
    };

    target.addEventListener("message", listener as EventListener);
  });
}

/** True when the extension's content script is listening on this page. */
export async function isExtensionBridgeAvailable(
  target: BridgeWindow = window,
  timeoutMs = BRIDGE_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const requestId = newRequestId();
  const answered = waitForMessage(target, requestId, BUNDLE_BRIDGE.probeAck, timeoutMs, () => true);
  target.postMessage({ channel: BUNDLE_BRIDGE.probe, requestId }, target.location.origin);
  try {
    return await answered;
  } catch {
    return false;
  }
}

export type BundleTransferResult = {
  bundleId: string;
  storedDocuments: BundleDocumentKind[];
  storedAt: string;
};

/**
 * Sends the bundle and resolves only once the extension confirms it is stored.
 * A rejection here means nothing was saved, so the caller must not navigate.
 */
export async function sendApplicationBundle(
  input: ApplicationBundleInput,
  target: BridgeWindow = window,
  timeoutMs = BRIDGE_TRANSFER_TIMEOUT_MS,
): Promise<BundleTransferResult> {
  if (input.documents.length === 0) {
    throw new ExtensionBridgeError("No tailored documents were prepared for this application.");
  }

  const requestId = newRequestId();
  const bundle = {
    websiteJobId: input.websiteJobId,
    company: input.company,
    jobTitle: input.jobTitle,
    jobDescription: input.jobDescription,
    officialApplicationUrl: input.officialApplicationUrl,
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.profile ? { profile: input.profile } : {}),
    approvedAnswers: input.approvedAnswers ?? [],
    ...(input.accountPreferences ? { accountPreferences: input.accountPreferences } : {}),
    documents: input.documents.map((document) => ({
      kind: document.kind,
      filename: document.filename,
      mimeType: document.mimeType,
      contentBase64: encodeBase64(document.bytes),
      byteLength: document.bytes.byteLength,
      generatedAt: document.generatedAt,
    })),
  };

  const answered = waitForMessage(target, requestId, BUNDLE_BRIDGE.result, timeoutMs, (data) => {
    const result = data.result as Record<string, unknown> | undefined;
    if (!result || result.ok !== true) {
      throw new ExtensionBridgeError(
        typeof result?.reason === "string"
          ? result.reason
          : "The extension refused the application bundle.",
      );
    }
    return {
      bundleId: String(result.bundleId),
      storedDocuments: (result.storedDocuments as BundleDocumentKind[]) ?? [],
      storedAt: String(result.storedAt),
    };
  });

  target.postMessage({ channel: BUNDLE_BRIDGE.offer, requestId, bundle }, target.location.origin);
  return answered;
}
