import type { NextConfig } from "next";

// Sitio 100 % estático para Cloudflare Pages (`out/`).
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
