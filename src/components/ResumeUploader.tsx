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
  onAnalyze: (text: string) => void;
  analyzing: boolean;
}) {
  const [doc, setDoc] = useState<UploadedDoc | null>(null);
  const [text, setText] = useState("");
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
      setDoc(data.document);
      setText(data.document.extractedText ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error uploading PDF.");
    } finally {
      setUploading(false);
    }
  }

  async function handleRemove() {
    const toDelete = doc;
    setDoc(null);
    setText("");
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
    if (file) handleFile(file);
  }

  return (
    <section className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
      <h2 className="font-medium text-slate-900">1. Upload your resume (PDF)</h2>

      {!doc && (
        <div
          data-testid="pdf-dropzone"
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={onDrop}
          className={`rounded-xl border-2 border-dashed p-10 text-center transition-colors ${
            dragActive ? "border-brand bg-brand/5" : "border-slate-300"
          }`}
        >
          <p className="text-slate-600 font-medium mb-3">Drag your resume PDF here</p>
          <p className="text-slate-400 text-sm mb-4">or</p>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="rounded-lg bg-brand text-white text-sm font-medium px-4 py-2.5 disabled:opacity-40 hover:bg-brand-dark transition-colors"
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
              if (file) handleFile(file);
            }}
          />
          <p className="text-xs text-slate-400 mt-4">
            PDF only, up to 10 MB. Extracted entirely on your computer — nothing is uploaded
            anywhere else.
          </p>
        </div>
      )}

      {error && (
        <div className="rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-sm px-4 py-3">
          {error}
        </div>
      )}

      {doc && doc.status === "scanned" && (
        <div className="space-y-3">
          <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm px-4 py-3">
            This PDF appears to be scanned. Text could not be extracted.
          </div>
          <div className="text-xs text-slate-500">
            {doc.filename} · {formatBytes(doc.sizeBytes)} · {doc.pageCount} page
            {doc.pageCount === 1 ? "" : "s"}
          </div>
          <button onClick={handleRemove} className="text-sm text-brand hover:underline">
            Remove and upload a different PDF
          </button>
        </div>
      )}

      {doc && doc.status === "ok" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4 text-xs text-slate-500">
            <span className="truncate">
              📄 {doc.filename} · {formatBytes(doc.sizeBytes)} · {doc.pageCount} page
              {doc.pageCount === 1 ? "" : "s"}
            </span>
            <button onClick={handleRemove} className="shrink-0 text-brand hover:underline">
              Remove / upload a different PDF
            </button>
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={14}
            className="w-full rounded-lg border border-slate-300 p-4 text-sm leading-relaxed font-mono focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand"
          />
          <button
            onClick={() => onAnalyze(text)}
            disabled={analyzing || text.trim().length < 30}
            className="rounded-lg bg-brand text-white text-sm font-medium px-4 py-2.5 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-brand-dark transition-colors"
          >
            {analyzing ? "Analyzing… (can take a minute)" : "Analyze Resume"}
          </button>
        </div>
      )}
    </section>
  );
}
