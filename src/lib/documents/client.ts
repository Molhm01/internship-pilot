export type StoredGeneratedDocument = {
  id: string;
  type: string;
  version: number;
  qaStatus: string;
  qaIssues: string | null;
  keywordClassification: string | null;
  tailoringStatus: string | null;
  tailoringAudit: string | null;
  identityVerified: boolean;
  createdAt: string;
};

export class DocumentRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentRequestError";
  }
}

export const DOCUMENT_GENERATION_TIMEOUT_MS = 90_000;

export type DocumentGenerationResponse = {
  ok: true;
  resumeDocumentId: string;
  coverLetterDocumentId?: string;
};

type GenerateRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export function sanitizeDocumentError(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const sanitized = value
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
  return sanitized || fallback;
}

async function responseError(response: Response, fallback: string): Promise<DocumentRequestError> {
  try {
    const payload = await response.json() as { error?: unknown };
    if (typeof payload.error === "string" && payload.error.trim()) {
      return new DocumentRequestError(sanitizeDocumentError(payload.error, fallback));
    }
  } catch {
    // The fallback deliberately avoids exposing an HTML error page in the UI.
  }
  return new DocumentRequestError(fallback);
}

export async function fetchJobDocuments(
  jobId: string,
  fetcher: typeof fetch = fetch,
): Promise<StoredGeneratedDocument[]> {
  const response = await fetcher(`/api/jobs/${jobId}/documents`);
  if (!response.ok) {
    throw await responseError(response, "Could not load saved tailored documents.");
  }
  const payload = await response.json() as { documents?: unknown };
  if (!Array.isArray(payload.documents)) {
    throw new DocumentRequestError("The saved-document response was not readable.");
  }
  return payload.documents as StoredGeneratedDocument[];
}

export async function generateTailoredDocuments(
  jobId: string,
  fetcher: typeof fetch = fetch,
  options: GenerateRequestOptions = {},
): Promise<DocumentGenerationResponse> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DOCUMENT_GENERATION_TIMEOUT_MS;
  let timedOut = false;
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (options.signal?.aborted) abortFromCaller();

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new DocumentRequestError(
          "Tailored document generation timed out. The button is ready to retry; existing versions were kept.",
        ));
      }, timeoutMs);
    });
    const response = await Promise.race([
      fetcher(`/api/jobs/${jobId}/generate-documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ includeCoverLetter: true }),
        signal: controller.signal,
      }),
      timeout,
    ]);
    if (!response.ok) {
      throw await responseError(response, "Could not generate tailored documents.");
    }
    let payload: { ok?: unknown; error?: unknown; resumeDocumentId?: unknown; coverLetterDocumentId?: unknown };
    try {
      payload = await response.json() as typeof payload;
    } catch {
      throw new DocumentRequestError("Document generation completed without a readable response.");
    }
    if (payload.ok !== true || typeof payload.resumeDocumentId !== "string") {
      throw new DocumentRequestError(sanitizeDocumentError(
        payload.error,
        "Document generation returned an incomplete persistence response.",
      ));
    }
    return {
      ok: true,
      resumeDocumentId: payload.resumeDocumentId,
      ...(typeof payload.coverLetterDocumentId === "string"
        ? { coverLetterDocumentId: payload.coverLetterDocumentId }
        : {}),
    };
  } catch (error) {
    if (timedOut) {
      throw new DocumentRequestError(
        "Tailored document generation timed out. The button is ready to retry; existing versions were kept.",
      );
    }
    if (error instanceof DocumentRequestError) throw error;
    if (controller.signal.aborted) {
      throw new DocumentRequestError("Tailored document generation was canceled. The button is ready to retry.");
    }
    throw new DocumentRequestError(sanitizeDocumentError(error instanceof Error ? error.message : error, "Could not generate tailored documents."));
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

export async function runTailoredDocumentGeneration(options: {
  jobId: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  onLoadingChange: (jobId: string, loading: boolean) => void;
  refreshDocuments: (jobId: string) => Promise<void>;
}): Promise<DocumentGenerationResponse> {
  options.onLoadingChange(options.jobId, true);
  try {
    const result = await generateTailoredDocuments(options.jobId, options.fetcher, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    await options.refreshDocuments(options.jobId);
    return result;
  } finally {
    options.onLoadingChange(options.jobId, false);
  }
}

export async function fetchDocumentPdf(
  documentId: string,
  fetcher: typeof fetch = fetch,
): Promise<Blob> {
  const response = await fetcher(`/api/documents/${documentId}/download`);
  if (!response.ok) {
    throw await responseError(response, "The generated PDF could not be opened.");
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/pdf")) {
    throw new DocumentRequestError("The stored document did not return a PDF file.");
  }
  return response.blob();
}
