"use client";

import { useEffect } from "react";

export function ThemeSync() {
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("ip-theme");
      const next = saved === "dark" || saved === "light" ? saved : "light";
      document.documentElement.setAttribute("data-theme", next);
    } catch {
      document.documentElement.setAttribute("data-theme", "light");
    }
  }, []);

  return null;
}
