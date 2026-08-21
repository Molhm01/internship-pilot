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
  | { status: "ready"; factCount: number }
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId }),
      });
      const data = await readJson<AnalyzeResponse>(res);
      if (!res.ok || data?.status !== "ready" || typeof data.factCount !== "number") {
        setAutomaticProfile({
          status: "failed",
          error: data?.error ?? `Resume analysis failed${res.status ? ` (HTTP ${res.status})` : ""}.`,
        });
        return;
      }
      setAutomaticProfile({ status: "ready", factCount: data.factCount });
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
    <section className="bg-surface rounded-lg border border-hairline p-6 space-y-4">
      <div>
        <h2 className="font-medium text-primary">Upload your resume</h2>
        <p className="mt-1 text-sm text-secondary">
          That&apos;s it. Internship Pilot extracts only facts written in the PDF and automatically scores your resume against every active job.
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
            dragActive ? "border-accent-line bg-accent/5" : "border-line"
          }`}
        >
          <p className="text-secondary font-medium mb-3">Drag your resume PDF here</p>
          <p className="text-faint text-sm mb-4">or</p>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="rounded-lg bg-accent text-white text-sm font-medium px-4 py-2.5 disabled:opacity-40 hover:bg-accent-dark transition-colors"
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
          <p className="text-xs text-faint mt-4">
            PDF only. Local development accepts up to 10 MB. Extracted text is used only to build your resume evidence and compare it with job descriptions.
          </p>
        </div>
      )}

      {error && (
        <div className="rounded-lg bg-critical-quiet border border-critical-line text-critical text-sm px-4 py-3">
          {error}
        </div>
      )}

      {doc && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4 text-xs text-tertiary">
            <span className="truncate">
              📄 {doc.filename} · {formatBytes(doc.sizeBytes)} · {doc.pageCount} page
              {doc.pageCount === 1 ? "" : "s"}
            </span>
            <button
              onClick={() => void handleRemove()}
              disabled={analyzing}
              className="shrink-0 text-accent-text hover:underline disabled:opacity-40"
            >
              Upload a different resume
            </button>
          </div>

          {warning && (
            <div className="rounded-lg bg-caution-quiet border border-caution-line text-caution text-sm px-4 py-3">
              {warning}
            </div>
          )}

          {doc.status === "scanned" || automaticProfile?.status === "scanned" ? (
            <div className="rounded-lg bg-caution-quiet border border-caution-line text-caution text-sm px-4 py-3">
              This PDF appears to be scanned, so its text could not be extracted. Upload a text-based PDF to enable automatic ATS scoring.
            </div>
          ) : automaticProfile?.status === "processing" ? (
            <div className="rounded-lg bg-accent/5 border border-accent-line text-secondary text-sm px-4 py-3">
              Resume uploaded. Local AI is extracting your resume evidence now. This can take a little longer the first time a model loads, but the PDF is already saved.
            </div>
          ) : automaticProfile?.status === "ready" ? (
            <div className="rounded-lg bg-positive-quiet border border-positive-line text-positive text-sm px-4 py-3">
              Resume ready. {automaticProfile.factCount} literal resume facts were extracted. ATS scoring is now queued automatically for every active internship, and future jobs will be scored too.
            </div>
          ) : automaticProfile?.status === "failed" ? (
            <div className="rounded-lg bg-critical-quiet border border-critical-line text-critical text-sm px-4 py-3">
              The PDF was saved, but automatic resume analysis could not finish: {automaticProfile.error}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
