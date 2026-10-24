import { fileURLToPath } from "node:url";

// Monorepo root: trace workspace packages into the standalone bundle, which
// places the server at .next/standalone/apps/web/server.js (see Dockerfile).
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Self-contained server bundle for the Docker image deployed to Vultr.
  output: "standalone",
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
};

export default nextConfig;
