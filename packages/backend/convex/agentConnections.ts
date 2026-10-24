import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  humanActor,
  recordWorkspaceEvent,
  requireMembership,
  requireUser,
} from "./lib/auth";
import {
  AGENT_CLIENTS,
  generateAgentToken,
  hashAgentToken,
} from "./lib/agent";

const connectionValidator = v.object({
  connectionId: v.id("agent_connections"),
  userId: v.id("users"),
  userName: v.string(),
  client: v.string(),
  displayName: v.union(v.string(), v.null()),
  createdAt: v.number(),
  lastMcpActionAt: v.union(v.number(), v.null()),
  lastSyncAt: v.union(v.number(), v.null()),
  revokedAt: v.union(v.number(), v.null()),
});

/**
 * Creates an MCP connection for the signed-in member in one workspace. The
 * plaintext token is returned only here; only its SHA-256 hash is stored.
 */
export const createAgentConnection = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    client: v.string(),
    displayName: v.optional(v.string()),
  },
  returns: v.object({
    connectionId: v.id("agent_connections"),
    token: v.string(),
    createdAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const { user } = await requireMembership(ctx, args.workspaceId);
    if (!(AGENT_CLIENTS as readonly string[]).includes(args.client))
      throw new ConvexError({ code: "INVALID_INPUT", field: "client" });
    const displayName = args.displayName?.trim() || undefined;
    if (displayName !== undefined && displayName.length > 100)
      throw new ConvexError({ code: "INVALID_INPUT", field: "displayName" });
    const token = generateAgentToken();
    const now = Date.now();
    const actor = humanActor(user);
    const connectionId = await ctx.db.insert("agent_connections", {
      workspaceId: args.workspaceId,
      userId: user._id,
      client: args.client,
      displayName,
      tokenHash: await hashAgentToken(token),
      updatedBy: actor,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    await recordWorkspaceEvent(ctx, {
      workspaceId: args.workspaceId,
      kind: "agent.connected",
      entityType: "agent_connection",
      entityId: connectionId,
      summary: `${actor.label} connected a ${args.client} assistant`,
      actor,
    });
    return { connectionId, token, createdAt: now };
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
