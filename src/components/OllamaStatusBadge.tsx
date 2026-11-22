"use client";

import { useEffect, useState } from "react";
import { getCachedOllamaHealth, type OllamaHealth } from "@/lib/ollamaHealthClient";

export default function OllamaStatusBadge() {
  const [health, setHealth] = useState<OllamaHealth | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getCachedOllamaHealth().then((data) => {
      if (!cancelled) setHealth(data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!health) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-tertiary">
        <span className="size-2 rounded-full bg-n-300 animate-pulse" />
        Checking AI engine…
      </span>
    );
  }

  if (health.reachable && health.modelInstalled) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-emerald-600">
        <span className="size-2 rounded-full bg-emerald-500" />
        Local AI + Grounded ATS Engine Ready ({health.model})
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-emerald-600">
      <span className="size-2 rounded-full bg-emerald-500" />
      Cloud &amp; Grounded ATS Matching Active
    </span>
  );
}
