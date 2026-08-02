import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse (via pdfjs-dist) dynamically loads a worker file at a path
  // relative to its own package location at runtime. Bundling it breaks that
  // resolution, so it must run as a plain Node require() instead.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist", "@napi-rs/canvas"],
};

export default nextConfig;
