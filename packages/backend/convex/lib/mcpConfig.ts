// Shared settings for the MCP endpoint (convex/mcp.ts), the consent page
// functions (convex/oauth.ts) and API keys (convex/agentConnections.ts). Kept
// out of mcp.ts so those modules don't import the server and its tools.
import { env } from "../_generated/server";
import type { AgentClient } from "./agent";

export const MCP_PATH = "/mcp";

export const MCP_SCOPES = {
  "tandem:read": "Read this workspace's files and project context",
  "tandem:write":
    "Create and update documents, publish work and update project context",
} as const;
export type McpScope = keyof typeof MCP_SCOPES;
export const ALL_MCP_SCOPES = Object.keys(MCP_SCOPES) as McpScope[];

/** Matches the component's own authorization-code lifetime. */
export const AUTH_CODE_TTL_MS = 60_000;

/**
 * Public origin of the Convex HTTP actions. siteUrl is left unset on the
 * component (docs/mcp-auth-design.md), so this is CONVEX_SITE_URL.
 */
export function mcpSiteUrl(): string {
  return env.CONVEX_SITE_URL.replace(/\/+$/, "");
}

/** The URL users paste into their assistant; also every token's audience. */
export function mcpResource(): string {
  return mcpSiteUrl() + MCP_PATH;
}

/** The dashboard's consent page. MCP_CONSENT_URL overrides `${SITE_URL}/oauth/consent`. */
export function mcpConsentUrl(): string {
  const explicit = env.MCP_CONSENT_URL;
  if (explicit) return explicit;
  const site = (env.SITE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${site}/oauth/consent`;
}

/**
 * Best guess at which assistant an OAuth client is, from where its codes are
 * sent. Only a suggestion for the consent page: the person picks the client.
 */
export function suggestClient(redirectUri: string | undefined): AgentClient {
  let host: string;
  try {
    host = new URL(redirectUri ?? "").hostname.toLowerCase();
  } catch {
    return "other";
  }
  const is = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (is("claude.ai") || is("claude.com") || is("anthropic.com")) return "claude";
  if (is("chatgpt.com") || is("openai.com")) return "chatgpt";
  if (is("gemini.google.com")) return "gemini";
  return "other";
}

/** OAuth clients name themselves (DCR), so names are short, single-line labels only. */
export function sanitizeClientName(name: string | undefined): string | undefined {
  const cleaned = name
    ?.replace(/[^\p{L}\p{N} ._()-]/gu, "")
    .trim()
    .slice(0, 60);
  return cleaned || undefined;
}

/** An API key: "mcp_sk_" + 32 random bytes as unpadded base64url. */
export const API_KEY_PATTERN = /^mcp_sk_[A-Za-z0-9_-]{43}$/;

export function randomSecret(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return prefix + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Hex SHA-256, the component's hash format for tokens, codes and API keys. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
