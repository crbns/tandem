import { ConvexError, v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalMutation, mutation, query } from "./_generated/server";
import {
  humanActor,
  recordWorkspaceEvent,
  requireMembership,
  requireUser,
} from "./lib/auth";
import { isAgentClient, revokeConnectionCredentials } from "./lib/agent";
import {
  ALL_MCP_SCOPES,
  mcpResource,
  randomSecret,
  sha256Hex,
} from "./lib/mcpConfig";

const connectionValidator = v.object({
  connectionId: v.id("agent_connections"),
  userId: v.id("users"),
  userName: v.string(),
  client: v.string(),
  displayName: v.union(v.string(), v.null()),
  /** null for legacy token rows, which no longer authenticate. */
  authKind: v.union(v.literal("api_key"), v.literal("oauth"), v.null()),
  /** OAuth only, self-reported by the client: show it as unverified. */
  oauthClientName: v.union(v.string(), v.null()),
  createdAt: v.number(),
  lastMcpActionAt: v.union(v.number(), v.null()),
  lastSyncAt: v.union(v.number(), v.null()),
  revokedAt: v.union(v.number(), v.null()),
});

/** The MCP server URL people paste into their assistant. */
export const getMcpServerUrl = query({
  args: {},
  returns: v.string(),
  handler: async () => mcpResource(),
});

/**
 * Creates an API-key connection for the signed-in member in one workspace,
 * for clients configured with a header (Claude Code, scripts). The key is
 * returned only here; the MCP component stores only its SHA-256 hash.
 * claude.ai and other OAuth clients connect through the consent page instead.
 */
export const createAgentConnection = action({
  args: {
    workspaceId: v.id("workspaces"),
    client: v.string(),
    displayName: v.optional(v.string()),
  },
  returns: v.object({
    connectionId: v.id("agent_connections"),
    token: v.string(),
    createdAt: v.number(),
    mcpUrl: v.string(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    connectionId: Id<"agent_connections">;
    token: string;
    createdAt: number;
    mcpUrl: string;
  }> => {
    // Generated in the action (real randomness); the mutation sees the hash.
    const token = randomSecret("mcp_sk_");
    const created: { connectionId: Id<"agent_connections">; createdAt: number } =
      await ctx.runMutation(internal.agentConnections.insertApiKeyConnection, {
        ...args,
        keyHash: await sha256Hex(token),
      });
    return { ...created, token, mcpUrl: mcpResource() };
  },
});

export const insertApiKeyConnection = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    client: v.string(),
    displayName: v.optional(v.string()),
    keyHash: v.string(),
  },
  returns: v.object({
    connectionId: v.id("agent_connections"),
    createdAt: v.number(),
  }),
  handler: async (ctx, args) => {
    // The caller's session, propagated from createAgentConnection.
    const { user } = await requireMembership(ctx, args.workspaceId);
    if (!isAgentClient(args.client))
      throw new ConvexError({ code: "INVALID_INPUT", field: "client" });
    const displayName = args.displayName?.trim() || undefined;
    if (displayName !== undefined && displayName.length > 100)
      throw new ConvexError({ code: "INVALID_INPUT", field: "displayName" });
    const now = Date.now();
    const actor = humanActor(user);
    const connectionId = await ctx.db.insert("agent_connections", {
      workspaceId: args.workspaceId,
      userId: user._id,
      client: args.client,
      displayName,
      authKind: "api_key",
      updatedBy: actor,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    // The key's grant acts for this connection, in this same transaction.
    await ctx.runMutation(components.mcp.grants.createApiKey, {
      userId: connectionId,
      name: displayName ?? `${args.client} API key`,
      scopes: ALL_MCP_SCOPES,
      resource: mcpResource(),
      hash: args.keyHash,
    });
    await recordWorkspaceEvent(ctx, {
      workspaceId: args.workspaceId,
      kind: "agent.connected",
      entityType: "agent_connection",
      entityId: connectionId,
      summary: `${actor.label} connected a ${args.client} assistant`,
      actor,
    });
    return { connectionId, createdAt: now };
  },
});

/** The caller's own connections; owners and admins see every connection in the workspace. */
export const listAgentConnections = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(connectionValidator),
  handler: async (ctx, { workspaceId }) => {
    const { user, membership } = await requireMembership(ctx, workspaceId);
    const seesAll = membership.role === "owner" || membership.role === "admin";
    const connections = seesAll
      ? await ctx.db
          .query("agent_connections")
          .withIndex("by_workspace_and_user", (q) =>
            q.eq("workspaceId", workspaceId),
          )
          .order("desc")
          .take(200)
      : await ctx.db
          .query("agent_connections")
          .withIndex("by_workspace_and_user", (q) =>
            q.eq("workspaceId", workspaceId).eq("userId", user._id),
          )
          .order("desc")
          .take(200);
    const names = new Map<string, string>();
    const result = [];
    for (const connection of connections) {
      let userName = names.get(connection.userId);
      if (userName === undefined) {
        const owner = await ctx.db.get(connection.userId);
        userName = owner?.name ?? owner?.email ?? "Workspace member";
        names.set(connection.userId, userName);
      }
      result.push({
        connectionId: connection._id,
        userId: connection.userId,
        userName,
        client: connection.client,
        displayName: connection.displayName ?? null,
        authKind: connection.authKind ?? null,
        oauthClientName: connection.oauthClientName ?? null,
        createdAt: connection.createdAt,
        lastMcpActionAt: connection.lastMcpActionAt ?? null,
        lastSyncAt: connection.lastSyncAt ?? null,
        revokedAt: connection.revokedAt ?? null,
      });
    }
    return result;
  },
});

/** The connection's own person, or an owner/admin of its workspace. Idempotent. */
export const revokeAgentConnection = mutation({
  args: { connectionId: v.id("agent_connections") },
  returns: v.null(),
  handler: async (ctx, { connectionId }) => {
    await requireUser(ctx);
    const connection = await ctx.db.get(connectionId);
    if (!connection) throw new ConvexError({ code: "FORBIDDEN" });
    // Authorize against the connection's own workspace, never a client-supplied one.
    const { user, membership } = await requireMembership(
      ctx,
      connection.workspaceId,
    );
    const isManager =
      membership.role === "owner" || membership.role === "admin";
    if (connection.userId !== user._id && !isManager)
      throw new ConvexError({ code: "FORBIDDEN" });
    // Also on a repeat call, so no credential can outlive a revoked row.
    await revokeConnectionCredentials(ctx, connectionId);
    if (connection.revokedAt !== undefined) return null;
    const now = Date.now();
    const actor = humanActor(user);
    await ctx.db.patch(connectionId, {
      revokedAt: now,
      updatedBy: actor,
      updatedAt: now,
      revision: connection.revision + 1,
    });
    await recordWorkspaceEvent(ctx, {
      workspaceId: connection.workspaceId,
      kind: "agent.revoked",
      entityType: "agent_connection",
      entityId: connectionId,
      summary: `${actor.label} revoked a ${connection.client} assistant connection`,
      actor,
    });
    return null;
  },
});
