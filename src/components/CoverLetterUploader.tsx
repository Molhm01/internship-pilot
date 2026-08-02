"use client";

import { useRef, useState } from "react";

const MAX_SIZE_BYTES = 10 * 1024 * 1024;

type UploadedDoc = {
  id: string;
  filename: string;
  sizeBytes: number;
  pageCount: number;
  status: "ok" | "scanned";
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// A lighter sibling of ResumeUploader for the optional master cover letter —
// same drag-and-drop / validation pattern, but no fact-extraction/analysis
// step (a master cover letter is just a reference document, not something we
// parse into structured facts).
export default function CoverLetterUploader() {
  const [doc, setDoc] = useState<UploadedDoc | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setError(null);
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setError("Only PDF files are accepted.");
      return;
    }
    if (file.size > MAX_SIZE_BYTES) {
      setError(`This file is ${(file.size / (1024 * 1024)).toFixed(1)} MB, over the 10 MB limit.`);
      return;
    }

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("kind", "coverLetter");
      const res = await fetch("/api/resume/upload", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not upload this PDF.");
        return;
      }
      setDoc(data.document);
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
    if (toDelete) await fetch(`/api/resume/documents/${toDelete.id}`, { method: "DELETE" }).catch(() => {});
  }

  return (
    <section className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
      <h2 className="font-medium text-slate-900">Master cover letter (optional)</h2>

      {!doc && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragActive(false);
            const file = e.dataTransfer.files?.[0];
            if (file) handleFile(file);
          }}
          className={`rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
            dragActive ? "border-brand bg-brand/5" : "border-slate-300"
          }`}
        >
          <p className="text-slate-600 font-medium mb-3">Drag your master cover letter PDF here</p>
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
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
          />
        </div>
      )}

      {error && (
        <div className="rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-sm px-4 py-3">{error}</div>
      )}

      {doc && (
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>
            📄 {doc.filename} · {formatBytes(doc.sizeBytes)} · {doc.pageCount} page{doc.pageCount === 1 ? "" : "s"}
          </span>
          <button onClick={handleRemove} className="text-brand hover:underline">
            Remove
          </button>
        </div>
      )}
    </section>
  );
}
