import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse (via pdfjs-dist) dynamically loads a worker file at a path
  // relative to its own package location at runtime. Bundling it breaks that
  // resolution, so it must run as a plain Node require() instead.
  // playwright: only the local application worker and the local diagnostics
  // probe touch it, and both do so through a dynamic import. Bundling a
  // browser-automation package into a serverless function would add hundreds
  // of megabytes to a deployment that never drives a browser.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist", "@napi-rs/canvas", "playwright"],
};

export default nextConfig;
