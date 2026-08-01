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

async function responseError(response: Response, fallback: string): Promise<DocumentRequestError> {
  try {
    const payload = await response.json() as { error?: unknown };
    if (typeof payload.error === "string" && payload.error.trim()) {
      return new DocumentRequestError(payload.error);
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
): Promise<void> {
  const response = await fetcher(`/api/jobs/${jobId}/generate-documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ includeCoverLetter: true }),
  });
  if (!response.ok) {
    throw await responseError(response, "Could not generate tailored documents.");
  }
  try {
    await response.json();
  } catch {
    throw new DocumentRequestError("Document generation completed without a readable response.");
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
