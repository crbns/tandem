import { fileURLToPath } from "node:url";

// Monorepo root: trace workspace packages into the standalone bundle, which
// places the server at .next/standalone/apps/web/server.js (see Dockerfile).
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// Sent on every response, so they travel with the image whatever proxy sits in
// front. frame-ancestors/X-Frame-Options stop clickjacking (e.g. tricking a
// signed-in user into saving or, later, approving). img-src keeps rendered
// documents from loading remote images. HSTS is set by Caddy, which owns TLS.
const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value:
      "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; img-src 'self' data: blob:",
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // Self-contained server bundle for the optional Docker image.
  output: "standalone",
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
};

export default nextConfig;
