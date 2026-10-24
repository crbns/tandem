import { components } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { ConvexError } from "convex/values";
import type { Actor } from "./auth";

type ReadCtx = QueryCtx | MutationCtx;

export const AGENT_CLIENTS = ["claude", "chatgpt", "gemini", "other"] as const;
export type AgentClient = (typeof AGENT_CLIENTS)[number];

export function isAgentClient(value: string): value is AgentClient {
  return (AGENT_CLIENTS as readonly string[]).includes(value);
}

/**
 * The credential the MCP component verified for a tool call (its McpUser).
 * Every grant and API key is created with `userId` set to one
 * agent_connections id, so `userId` names the connection, not the person.
 */
export interface McpPrincipal {
  userId: string;
  scopes: string[];
  clientId?: string;
  connectionId: string;
}

/** A verified agent connection, its person, and their current membership. */
export interface AgentSession {
  connection: Doc<"agent_connections">;
  user: Doc<"users">;
  membership: Doc<"workspace_members">;
  workspaceId: Id<"workspaces">;
  actor: Actor;
  scopes: string[];
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
 * Resolves an MCP call to its agent connection. A revoked or unknown
 * connection is UNAUTHENTICATED (revoking also deletes its component grants,
 * so the next request gets a 401 before it reaches a tool); a connection whose
 * person has left the workspace is FORBIDDEN. Identity comes only from the
 * verified credential, never from tool arguments.
 */
export async function requireAgent(
  ctx: ReadCtx,
  principal: McpPrincipal,
): Promise<AgentSession> {
  const connectionId = ctx.db.normalizeId("agent_connections", principal.userId);
  const connection = connectionId ? await ctx.db.get(connectionId) : null;
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
    scopes: principal.scopes,
  };
}

/**
 * The component already hides and refuses tools outside a connection's
 * scopes; this re-checks inside the transaction that writes.
 */
export function requireWriteScope(session: AgentSession): void {
  if (!session.scopes.includes("tandem:write"))
    throw new ConvexError({ code: "FORBIDDEN", scope: "tandem:write" });
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

/**
 * Deletes every MCP credential acting for a connection: its OAuth grant(s)
 * with their access and refresh tokens, or its API key. The next MCP request
 * with any of them gets 401.
 */
export async function revokeConnectionCredentials(
  ctx: MutationCtx,
  connectionId: Id<"agent_connections">,
): Promise<void> {
  const grants = await ctx.runQuery(components.mcp.grants.list, {
    userId: connectionId,
  });
  for (const grant of grants) {
    await ctx.runMutation(components.mcp.grants.revoke, {
      userId: connectionId,
      grantId: grant._id,
    });
  }
}
