"use client";

import { useRef, useState } from "react";

const MAX_SIZE_BYTES = 10 * 1024 * 1024;

type UploadedDoc = {
  id: string;
  filename: string;
  sizeBytes: number;
  pageCount: number;
  status: "ok" | "scanned";
  extractedText: string;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function ResumeUploader({
  onAnalyze,
  analyzing,
}: {
  onAnalyze: (text: string) => void | Promise<void>;
  analyzing: boolean;
}) {
  const [doc, setDoc] = useState<UploadedDoc | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setError(null);

    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setError("Only PDF files are accepted. Please choose a .pdf file.");
      return;
    }
    if (file.size > MAX_SIZE_BYTES) {
      setError(
        `This file is ${(file.size / (1024 * 1024)).toFixed(1)} MB, which is over the 10 MB limit. Please choose a smaller PDF.`,
      );
      return;
    }

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/resume/upload", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not upload this PDF.");
        return;
      }

      const uploaded = data.document as UploadedDoc;
      setDoc(uploaded);

      // Resume submission is the action. As soon as text extraction succeeds,
      // build the candidate profile and queue job matches — no second button.
      if (uploaded.status === "ok" && uploaded.extractedText.trim().length >= 30) {
        await onAnalyze(uploaded.extractedText);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error uploading PDF.");
    } finally {
      setUploading(false);
    }
  }

  async function handleRemove() {
    const toDelete = doc;
    setDoc(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
    if (toDelete) {
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
        <p className="mt-1 text-sm text-tertiary">
          One PDF is enough. Internship Pilot extracts your resume profile and automatically scores
          every active internship against it.
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
            disabled={uploading || analyzing}
            className="rounded-lg bg-accent text-white text-sm font-medium px-4 py-2.5 disabled:opacity-40 hover:bg-accent-dark transition-colors"
          >
            {uploading ? "Uploading…" : "Choose PDF"}
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
          <p className="text-xs text-faint mt-4">PDF only, up to 10 MB.</p>
        </div>
      )}

      {error && (
        <div className="rounded-lg bg-critical-quiet border border-critical-line text-critical text-sm px-4 py-3">
          {error}
        </div>
      )}

      {doc && doc.status === "scanned" && (
        <div className="space-y-3">
          <div className="rounded-lg bg-caution-quiet border border-caution-line text-caution text-sm px-4 py-3">
            This PDF appears to be scanned. Text could not be extracted, so it cannot be used for automatic matching yet.
          </div>
          <div className="text-xs text-tertiary">
            {doc.filename} · {formatBytes(doc.sizeBytes)} · {doc.pageCount} page
            {doc.pageCount === 1 ? "" : "s"}
          </div>
          <button onClick={handleRemove} className="text-sm text-accent-text hover:underline">
            Remove and upload a different PDF
          </button>
        </div>
      )}

      {doc && doc.status === "ok" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4 text-xs text-tertiary">
            <span className="truncate">
              📄 {doc.filename} · {formatBytes(doc.sizeBytes)} · {doc.pageCount} page
              {doc.pageCount === 1 ? "" : "s"}
            </span>
            <button
              onClick={handleRemove}
              disabled={analyzing}
              className="shrink-0 text-accent-text hover:underline disabled:opacity-40"
            >
              Upload a different resume
            </button>
          </div>

          <div
            className={`rounded-lg border px-4 py-3 text-sm ${
              analyzing
                ? "border-accent-line bg-accent/5 text-accent-text"
                : "border-verified-line bg-verified-quiet text-verified"
            }`}
          >
            {analyzing
              ? "Analyzing your resume and preparing automatic job matches…"
              : "Resume submitted. Your internship match scores update automatically."}
          </div>
        </div>
      )}
    </section>
  );
}
