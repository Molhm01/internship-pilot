"use client";

import { useRef, useState } from "react";

// The server-side PDF parser accepts 10 MB. Hosted Vercel request bodies are
// smaller than that, so the browser keeps the hosted safety cap while allowing
// the full local limit during development on localhost.
const MAX_HOSTED_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_LOCAL_UPLOAD_BYTES = 10 * 1024 * 1024;

type UploadedDoc = {
  id: string | null;
  filename: string;
  sizeBytes: number;
  pageCount: number;
  status: "ok" | "scanned";
  persisted?: boolean;
};

type AutomaticProfile =
  | { status: "processing" }
  | { status: "ready"; factCount: number; scoredJobs?: number; totalActive?: number }
  | { status: "failed"; error: string }
  | { status: "not_applicable" }
  | { status: "scanned" };

type UploadResponse = {
  document?: UploadedDoc;
  automaticProfile?: AutomaticProfile;
  warning?: string | null;
  error?: string;
};

type AnalyzeResponse = {
  status?: "ready";
  factCount?: number;
  queuedJobs?: number;
  scoredJobs?: number;
  totalActive?: number;
  error?: string;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function currentUploadLimitBytes(): number {
  if (typeof window === "undefined") return MAX_HOSTED_UPLOAD_BYTES;
  const host = window.location.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1"
    ? MAX_LOCAL_UPLOAD_BYTES
    : MAX_HOSTED_UPLOAD_BYTES;
}

async function readJson<T>(response: Response): Promise<T | null> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export default function ResumeUploader({
  onProcessed,
}: {
  onProcessed?: () => void | Promise<void>;
}) {
  const [doc, setDoc] = useState<UploadedDoc | null>(null);
  const [automaticProfile, setAutomaticProfile] = useState<AutomaticProfile | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function analyzeUploadedResume(documentId: string) {
    setAnalyzing(true);
    setAutomaticProfile({ status: "processing" });
    try {
      const res = await fetch("/api/resume/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ documentId }),
      });
      const contentType = res.headers.get("content-type") ?? "";
      if (res.redirected || contentType.includes("text/html")) {
        setAutomaticProfile({
          status: "failed",
          error: "Session expired or redirected during resume analysis. Please reload and try again.",
        });
        return;
      }
      const data = await readJson<AnalyzeResponse>(res);
      if (!res.ok || data?.status !== "ready" || typeof data.factCount !== "number") {
        setAutomaticProfile({
          status: "failed",
          error:
            data?.error ??
            (res.ok
              ? "Resume analysis returned an unexpected response payload."
              : `Resume analysis failed (HTTP ${res.status}).`),
        });
        return;
      }
      setAutomaticProfile({
        status: "ready",
        factCount: data.factCount,
        scoredJobs: data.scoredJobs,
        totalActive: data.totalActive,
      });
      await onProcessed?.();
    } catch (err) {
      setAutomaticProfile({
        status: "failed",
        error: err instanceof Error ? err.message : "Network error while analyzing the resume.",
      });
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleFile(file: File) {
    setError(null);
    setWarning(null);
    setAutomaticProfile(null);

    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setError("Only PDF files are accepted. Please choose a .pdf file.");
      return;
    }

    const uploadLimit = currentUploadLimitBytes();
    if (file.size > uploadLimit) {
      setError(
        `This file is ${(file.size / (1024 * 1024)).toFixed(1)} MB. The current upload limit is ${Math.round(uploadLimit / (1024 * 1024))} MB. Export or compress the resume PDF, then upload it again.`,
      );
      return;
    }

    setUploading(true);
    let uploaded: UploadResponse | null = null;
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/resume/upload", { method: "POST", body: formData });
      uploaded = await readJson<UploadResponse>(res);
      if (!res.ok || !uploaded?.document) {
        if (res.status === 413) {
          setError("This PDF is too large for the current upload endpoint.");
        } else {
          setError(uploaded?.error ?? `Could not upload this PDF${res.status ? ` (HTTP ${res.status})` : ""}.`);
        }
        return;
      }
      setDoc(uploaded.document);
      setAutomaticProfile(uploaded.automaticProfile ?? null);
      setWarning(uploaded.warning ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error uploading PDF.");
      return;
    } finally {
      setUploading(false);
    }

    if (
      uploaded?.document?.id
      && uploaded.automaticProfile?.status === "processing"
    ) {
      await analyzeUploadedResume(uploaded.document.id);
    }
  }

  async function handleRemove() {
    const toDelete = doc;
    setDoc(null);
    setAutomaticProfile(null);
    setWarning(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
    if (toDelete?.id) {
      await fetch(`/api/resume/documents/${toDelete.id}`, { method: "DELETE" }).catch(() => {});
    }
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  }

  return (
    <section className="rounded-lg border border-hairline bg-surface p-6 shadow-raised space-y-4">
      <div>
        <h2 className="font-display text-subhead font-semibold text-primary">Upload your resume</h2>
        <p className="mt-1 text-small text-secondary">
          Upload one text-based PDF. Internship Pilot extracts your facts automatically and scores 100% of active internships immediately.
        </p>
      </div>

      {!doc && (
        <div
          data-testid="pdf-dropzone"
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={onDrop}
          className={`rounded-lg border-2 border-dashed p-10 text-center transition-colors ${
            dragActive ? "border-accent-line bg-accent-quiet" : "border-line bg-canvas/50"
          }`}
        >
          <p className="mb-3 font-medium text-secondary">Drag your resume PDF here</p>
          <p className="mb-4 text-small text-tertiary">or</p>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-md bg-accent px-4 text-small font-medium text-inverse transition-colors hover:bg-accent-hover disabled:opacity-45"
          >
            {uploading ? "Uploading resume…" : "Choose PDF"}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            data-testid="pdf-file-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
            }}
          />
          <p className="mt-4 text-micro text-tertiary">
            PDF only (up to 10 MB locally). Extracted facts immediately drive scoring and tailored application PDFs.
          </p>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-critical-line bg-critical-quiet px-4 py-3 text-small text-critical">
          {error}
        </div>
      )}

      {doc && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4 text-micro text-tertiary">
            <span className="truncate font-mono">
              {doc.filename} · {formatBytes(doc.sizeBytes)} · {doc.pageCount} page
              {doc.pageCount === 1 ? "" : "s"}
            </span>
            <button
              type="button"
              onClick={() => void handleRemove()}
              disabled={analyzing}
              className="shrink-0 whitespace-nowrap font-medium text-accent-text hover:underline disabled:opacity-40"
            >
              Upload a different resume
            </button>
          </div>

          {warning && (
            <div className="rounded-lg border border-caution-line bg-caution-quiet px-4 py-3 text-small text-caution">
              {warning}
            </div>
          )}

          {doc.status === "scanned" || automaticProfile?.status === "scanned" ? (
            <div className="rounded-lg border border-caution-line bg-caution-quiet px-4 py-3 text-small text-caution">
              This PDF appears to be scanned, so its text could not be extracted. Upload a text-based PDF to enable automatic ATS scoring.
            </div>
          ) : automaticProfile?.status === "processing" ? (
            <div className="rounded-lg border border-accent-line bg-accent-quiet px-4 py-3 text-small text-secondary">
              Resume uploaded. Extracting your evidence and scoring all active internships…
            </div>
          ) : automaticProfile?.status === "ready" ? (
            <div className="rounded-lg border border-positive-line bg-positive-quiet px-4 py-3 text-small text-positive">
              Resume ready. Extracted {automaticProfile.factCount} facts and scored{" "}
              {typeof automaticProfile.totalActive === "number"
                ? `${automaticProfile.scoredJobs ?? automaticProfile.totalActive} / ${automaticProfile.totalActive} active internships (100%)`
                : "every active internship"}.
            </div>
          ) : automaticProfile?.status === "failed" ? (
            <div className="rounded-lg border border-critical-line bg-critical-quiet px-4 py-3 text-small text-critical">
              Automatic resume analysis encountered an error: {automaticProfile.error}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
