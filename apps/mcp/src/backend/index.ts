import { MockBackend } from "./mock.js";
import type { TandemBackend } from "./types.js";

/**
 * Only the in-memory mock: the real MCP server is @convex-dev/mcp in the
 * Convex deployment (packages/backend/convex/mcp.ts). This package is a local
 * harness for the skill eval and never deploys.
 */
export function createBackend(kind: string): TandemBackend {
  switch (kind) {
    case "mock":
      return new MockBackend();
    default:
      throw new Error(
        `Unknown TANDEM_BACKEND "${kind}". Only "mock" is supported; the real MCP server runs in Convex at <CONVEX_SITE_URL>/mcp.`,
      );
  }
}
