import type { AgentConnection } from "./api/types";

export const MCP_URL_PLACEHOLDER = "<MCP_URL>";

/** The MCP endpoint for a base URL: trailing slashes trimmed, `/mcp` appended once. */
export function mcpEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "") || MCP_URL_PLACEHOLDER;
  return base.endsWith("/mcp") ? base : `${base}/mcp`;
}

/** The one-line Claude Code setup for a fresh connection token. */
export function claudeCodeCommand(baseUrl: string, token: string): string {
  return `claude mcp add --transport http tandem ${mcpEndpoint(baseUrl)} --header "Authorization: Bearer ${token}"`;
}

/** Revoked connections sink to the bottom; otherwise the most recently created first. */
export function sortConnections(connections: AgentConnection[]): AgentConnection[] {
  return [...connections].sort(
    (a, b) => Number(a.revokedAt !== undefined) - Number(b.revokedAt !== undefined) || b.createdAt - a.createdAt,
  );
}
