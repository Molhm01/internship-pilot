import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse (via pdfjs-dist) dynamically loads a worker file at a path
  // relative to its own package location at runtime. Bundling it breaks that
  // resolution, so it must run as a plain Node require() instead.
  //
  // Prisma's PostgreSQL driver adapter must also stay server-external. The
  // Windows local launcher intentionally uses Webpack for dev stability. When
  // Webpack followed @prisma/adapter-pg -> pg -> pg-connection-string it tried
  // to resolve Node's built-in `fs` as if it were browser code, which made the
  // whole app (including /api/extension/health) fail to compile. These packages
  // are server-only and are installed at the project root, so Node should load
  // them directly at runtime instead of Next bundling their internals.
  //
  // playwright: only the local application worker and the local diagnostics
  // probe touch it, and both do so through a dynamic import. Bundling a
  // browser-automation package into a serverless function would add hundreds
  // of megabytes to a deployment that never drives a browser.
  serverExternalPackages: [
    "pdf-parse",
    "pdfjs-dist",
    "@napi-rs/canvas",
    "playwright",
    "@prisma/adapter-pg",
    "pg",
    "pg-connection-string",
  ],
};

export default nextConfig;
