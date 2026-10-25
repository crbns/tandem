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
  options: { sync?: boolean; syncedContextRevision?: number; syncedContextBrief?: boolean } = {},
): Promise<void> {
  const now = Date.now();
  await ctx.db.patch(session.connection._id, {
    lastMcpActionAt: now,
    ...(options.sync ? { lastSyncAt: now } : {}),
    ...(options.syncedContextRevision !== undefined
      ? { syncedContextRevision: options.syncedContextRevision }
      : {}),
    ...(options.syncedContextBrief !== undefined
      ? { syncedContextBrief: options.syncedContextBrief }
      : {}),
  });
}

export type ActivityKind = Doc<"agent_activity">["kind"];
export type ActivityResource = NonNullable<Doc<"agent_activity">["resource"]>;

// A successful write links back to this connection's own conflict on the
// same resource when it comes within this window.
const RESOLVE_WINDOW_MS = 30 * 60 * 1000;
const RESOLVE_SCAN = 20;
// An identical read repeated within this window adds no row: presence still
// moves, but a chatty assistant re-listing or re-reading doesn't grow the log.
const READ_REPEAT_MS = 60 * 1000;
const LABEL_MAX = 80;

/** Codes that mean "someone else got there first" rather than a failure. */
export const CONFLICT_CODES = new Set(["VERSION_CONFLICT", "TASK_ALREADY_CLAIMED"]);

export function activityLabel(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > LABEL_MAX ? `${trimmed.slice(0, LABEL_MAX - 1)}…` : trimmed;
}

/** The project context version right now (0 before any context exists). */
export async function currentContextRevision(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
): Promise<number> {
  const context = await ctx.db
    .query("structured_context")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  return context?.revision ?? 0;
}

/**
 * Appends one agent_activity row for an MCP call. Successful calls record it
 * in their own tool mutation; failed ones from mcpTools.touchConnection after
 * the rollback. `summary` must be generated text: never file content, prompt
 * text or a rationale. Never written to workspace_events.
 */
export async function recordActivity(
  ctx: MutationCtx,
  session: AgentSession,
  entry: {
    tool: string;
    kind: ActivityKind;
    outcome?: Doc<"agent_activity">["outcome"];
    errorCode?: string;
    summary: string;
    resource?: ActivityResource;
    contextRevision?: number;
    previousSyncedContextRevision?: number;
  },
): Promise<Id<"agent_activity">> {
  const now = Date.now();
  const outcome = entry.outcome ?? "ok";
  if (outcome === "ok" && entry.kind === "read") {
    const latest = await ctx.db
      .query("agent_activity")
      .withIndex("by_connection_and_created", (q) =>
        q.eq("agentConnectionId", session.connection._id).gte("createdAt", now - READ_REPEAT_MS),
      )
      .order("desc")
      .first();
    if (
      latest?.kind === "read" &&
      latest.outcome === "ok" &&
      latest.tool === entry.tool &&
      latest.summary === entry.summary &&
      latest.resource?.id === entry.resource?.id
    )
      return latest._id;
  }
  let resolvesActivityId: Id<"agent_activity"> | undefined;
  if (
    outcome === "ok" &&
    (entry.kind === "write" || entry.kind === "task") &&
    entry.resource
  ) {
    // The newest earlier attempt on this resource decides: a conflict that no
    // write has followed yet is unresolved. Reads in between don't count.
    const recent = await ctx.db
      .query("agent_activity")
      .withIndex("by_connection_and_created", (q) =>
        q
          .eq("agentConnectionId", session.connection._id)
          .gte("createdAt", now - RESOLVE_WINDOW_MS),
      )
      .order("desc")
      .take(RESOLVE_SCAN);
    for (const row of recent) {
      if (row.resource?.type !== entry.resource.type || row.resource.id !== entry.resource.id)
        continue;
      if (row.kind === "read" || row.kind === "error") continue;
      // Only a stale write the agent then fixed counts; TASK_ALREADY_CLAIMED
      // means someone else won, not that this write resolved it.
      if (row.outcome === "conflict" && row.errorCode === "VERSION_CONFLICT")
        resolvesActivityId = row._id;
      break;
    }
  }
  return await ctx.db.insert("agent_activity", {
    workspaceId: session.workspaceId,
    agentConnectionId: session.connection._id,
    actor: session.actor,
    tool: entry.tool,
    kind: entry.kind,
    outcome,
    ...(entry.errorCode !== undefined ? { errorCode: entry.errorCode } : {}),
    summary: entry.summary,
    ...(entry.resource
      ? {
          resource: {
            ...entry.resource,
            ...(entry.resource.label !== undefined
              ? { label: activityLabel(entry.resource.label) }
              : {}),
          },
        }
      : {}),
    contextRevision:
      entry.contextRevision ??
      (await currentContextRevision(ctx, session.workspaceId)),
    ...(entry.previousSyncedContextRevision !== undefined
      ? { previousSyncedContextRevision: entry.previousSyncedContextRevision }
      : {}),
    ...(resolvesActivityId ? { resolvesActivityId } : {}),
    createdAt: now,
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
