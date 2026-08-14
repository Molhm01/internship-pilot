"use client";

import { useEffect, useState } from "react";
import { getCachedOllamaHealth, type OllamaHealth } from "@/lib/ollamaHealthClient";

export default function OllamaStatusBadge() {
  const [health, setHealth] = useState<OllamaHealth | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getCachedOllamaHealth()
      .then((data) => {
        if (!cancelled) setHealth(data);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!health) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-tertiary">
        <span className="w-2 h-2 rounded-full bg-n-300 animate-pulse" />
        Checking Ollama…
      </span>
    );
  }

  if (!health.reachable) {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs text-rose-600"
        title={health.error}
      >
        <span className="w-2 h-2 rounded-full bg-rose-500" />
        Ollama not reachable at localhost:11434
      </span>
    );
  }

  if (!health.modelInstalled) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-amber-600">
        <span className="w-2 h-2 rounded-full bg-amber-500" />
        Ollama is running, but model &quot;{health.model}&quot; is not installed
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-emerald-600">
      <span className="w-2 h-2 rounded-full bg-emerald-500" />
      Ollama connected ({health.model})
    </span>
  );
}
