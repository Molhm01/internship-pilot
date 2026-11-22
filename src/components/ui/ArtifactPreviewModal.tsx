"use client";

import { useEffect, useState } from "react";
import { Download, ExternalLink, Loader2, X } from "lucide-react";

interface ArtifactPreviewModalProps {
  open: boolean;
  url: string | null;
  loadBlob?: (() => Promise<Blob>) | null;
  title: string;
  filename?: string;
  kind?: "image" | "pdf";
  onClose: () => void;
}

/**
 * Fetches an authenticated image or PDF using credentials ("include") inside the
 * current iframe origin so Chrome's partitioned cookie jar stays intact, then
 * renders it via an in-memory Blob URL.
 */
export function ArtifactPreviewModal({
  open,
  url,
  loadBlob,
  title,
  filename = "artifact",
  kind = "image",
  onClose,
}: ArtifactPreviewModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [detectedKind, setDetectedKind] = useState<"image" | "pdf">(kind);

  useEffect(() => {
    if (!open || (!url && !loadBlob)) return;
    let cancelled = false;
    let createdUrl: string | null = null;

    setLoading(true);
    setError(null);
    setBlobUrl(null);
    setDetectedKind(kind);

    const blobPromise = loadBlob
      ? loadBlob().then((blob) => ({ blob, ct: blob.type || "" }))
      : fetch(url!, { credentials: "include", cache: "no-store" }).then(async (res) => {
          if (!res.ok) {
            const payload = (await res.json().catch(() => null)) as { error?: string } | null;
            throw new Error(payload?.error || `Failed to load artifact (HTTP ${res.status}).`);
          }
          const ct = (res.headers.get("content-type") || "").toLowerCase();
          const blob = await res.blob();
          return { blob, ct };
        });

    void blobPromise
      .then(({ blob, ct }) => {
        if (cancelled) return;
        createdUrl = URL.createObjectURL(blob);
        if (ct.includes("pdf")) {
          setDetectedKind("pdf");
        } else if (ct.includes("image")) {
          setDetectedKind("image");
        }
        setBlobUrl(createdUrl);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not load preview.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [open, url, loadBlob, kind]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-3">
          <div className="min-w-0">
            <h3 className="truncate text-small font-semibold text-primary">{title}</h3>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {blobUrl && (
              <>
                <a
                  href={blobUrl}
                  download={filename}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-canvas px-2.5 text-micro font-medium text-primary hover:bg-sunken"
                >
                  <Download className="size-3.5" aria-hidden />
                  Download
                </a>
                <a
                  href={blobUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-canvas px-2.5 text-micro font-medium text-accent-text hover:bg-sunken"
                >
                  <ExternalLink className="size-3.5" aria-hidden />
                  Open Tab
                </a>
              </>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close preview"
              className="inline-flex size-7 items-center justify-center rounded-md border border-line text-tertiary hover:bg-sunken hover:text-primary"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto bg-canvas/80 p-4">
          {loading ? (
            <div className="flex h-64 flex-col items-center justify-center gap-2 text-small text-tertiary">
              <Loader2 className="size-5 animate-spin text-accent" aria-hidden />
              <span>Loading captured artifact…</span>
            </div>
          ) : error ? (
            <div className="rounded-lg border border-critical-line bg-critical-quiet p-4 text-small text-critical" role="alert">
              {error}
            </div>
          ) : blobUrl ? (
            detectedKind === "pdf" ? (
              <iframe
                src={blobUrl}
                title={title}
                className="h-[72vh] w-full rounded-md border border-hairline bg-white"
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={blobUrl}
                alt={title}
                className="mx-auto max-h-[75vh] w-auto rounded-md border border-hairline shadow-raised"
              />
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}
