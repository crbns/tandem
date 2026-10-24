import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { ConvexError } from "convex/values";
import type { Actor } from "./auth";

type ReadCtx = QueryCtx | MutationCtx;

export const AGENT_CLIENTS = ["claude", "chatgpt", "gemini", "other"] as const;
export type AgentClient = (typeof AGENT_CLIENTS)[number];

const TOKEN_PREFIX = "tdm_";
// "tdm_" + 32 random bytes as unpadded base64url.
const TOKEN_PATTERN = /^tdm_[A-Za-z0-9_-]{43}$/;

/** A verified agent connection, its person, and their current membership. */
export interface AgentSession {
  connection: Doc<"agent_connections">;
  user: Doc<"users">;
  membership: Doc<"workspace_members">;
  workspaceId: Id<"workspaces">;
  actor: Actor;
}

export function generateAgentToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const base64 = btoa(String.fromCharCode(...bytes));
  return (
    TOKEN_PREFIX +
    base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  );
}

export async function hashAgentToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function agentActor(
  connection: Doc<"agent_connections">,
  user: Doc<"users">,
): Actor {
  const userName = user.name ?? user.email ?? "Workspace member";
  return {
    type: "agent",
    userId: user._id,
    agentConnectionId: connection._id,
    client: connection.client,
    label: connection.displayName ?? `${userName}'s ${connection.client} assistant`,
    userName,
  };
}

/**
 * Verifies an MCP bearer token. Unknown, malformed and revoked tokens are all
 * UNAUTHENTICATED; a connection whose person has left the workspace is
 * FORBIDDEN. Identity comes only from the connection row, never from args.
 */
export async function requireAgent(
  ctx: ReadCtx,
  token: string,
): Promise<AgentSession> {
  if (!TOKEN_PATTERN.test(token))
    throw new ConvexError({ code: "UNAUTHENTICATED" });
  const tokenHash = await hashAgentToken(token);
  const connection = await ctx.db
    .query("agent_connections")
    .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
    .unique();
  if (!connection || connection.revokedAt !== undefined)
    throw new ConvexError({ code: "UNAUTHENTICATED" });
  const user = await ctx.db.get(connection.userId);
  if (!user) throw new ConvexError({ code: "UNAUTHENTICATED" });
  const membership = await ctx.db
    .query("workspace_members")
    .withIndex("by_workspace_and_user", (q) =>
      q.eq("workspaceId", connection.workspaceId).eq("userId", user._id),
    )
    .unique();
  if (!membership)
    throw new ConvexError({
      code: "FORBIDDEN",
      workspaceId: connection.workspaceId,
    });
  return {
    connection,
    user,
    membership,
    workspaceId: connection.workspaceId,
    actor: agentActor(connection, user),
  };
}

/**
 * A connection is bound to one workspace, which is also its default. Any other
 * workspace id (including a malformed one) is FORBIDDEN.
 */
export function resolveAgentWorkspace(
  session: AgentSession,
  workspaceId: string | undefined,
): Id<"workspaces"> {
  if (workspaceId !== undefined && workspaceId !== session.workspaceId)
    throw new ConvexError({ code: "FORBIDDEN", workspaceId });
  return session.workspaceId;
}

/** Presence: every agent call sets lastMcpActionAt; sync also sets lastSyncAt. */
export async function touchConnection(
  ctx: MutationCtx,
  session: AgentSession,
  options: { sync?: boolean } = {},
): Promise<void> {
  const now = Date.now();
  await ctx.db.patch(session.connection._id, {
    lastMcpActionAt: now,
    ...(options.sync ? { lastSyncAt: now } : {}),
  });
}
