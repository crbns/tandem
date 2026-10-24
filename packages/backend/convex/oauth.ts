// The dashboard's OAuth consent page (apps/web/app/oauth/consent). An
// assistant's authorize request lands there as `?request=<id>`; the signed-in
// person picks the workspace and the assistant, then approves or denies.
//
// We don't use the component's stock `authorize`: approval here creates one
// agent_connections row and binds the authorization code to it in the same
// transaction (the component's `userId` is that row's id). Tokens minted from
// the code therefore act for exactly one person in exactly one workspace, and
// revoking the row on the Assistants page deletes them (agentConnections.ts).
import { ConvexError, v } from "convex/values";
import { components, internal } from "./_generated/api";
import { action, internalMutation, query } from "./_generated/server";
import {
  humanActor,
  recordWorkspaceEvent,
  requireHumanSession,
  requireMembership,
  requireUser,
} from "./lib/auth";
import { AGENT_CLIENTS, isAgentClient } from "./lib/agent";
import {
  AUTH_CODE_TTL_MS,
  MCP_SCOPES,
  mcpSiteUrl,
  randomSecret,
  sanitizeClientName,
  sha256Hex,
  suggestClient,
} from "./lib/mcpConfig";
import { roleValidator } from "./lib/validators";

const clientValidator = v.union(...AGENT_CLIENTS.map((client) => v.literal(client)));

/** What the consent page shows the signed-in person, or null when the request is gone. */
export const getConsentRequest = query({
  args: { requestId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      status: v.union(v.literal("pending"), v.literal("approved"), v.literal("denied")),
      /** Self-reported by the client through dynamic registration: label it unverified. */
      clientName: v.union(v.string(), v.null()),
      /** Where the assistant receives the code, i.e. where the access goes. */
      redirectHost: v.union(v.string(), v.null()),
      suggestedClient: clientValidator,
      scopes: v.array(v.object({ name: v.string(), description: v.string() })),
      workspaces: v.array(
        v.object({ id: v.id("workspaces"), name: v.string(), role: roleValidator }),
      ),
    }),
  ),
  handler: async (ctx, { requestId }) => {
    const user = await requireUser(ctx);
    const request = await ctx.runQuery(components.mcp.oauth.getAuthRequest, { requestId });
    // deviceFlow is off, so only redirect requests can exist; refuse anything else.
    if (!request || request.kind !== "redirect") return null;
    let redirectHost: string | null = null;
    try {
      redirectHost = new URL(request.redirectUri ?? "").host || null;
    } catch {
      redirectHost = null;
    }
    const memberships = await ctx.db
      .query("workspace_members")
      .withIndex("by_user_and_workspace", (q) => q.eq("userId", user._id))
      .take(100);
    const workspaces = [];
    for (const membership of memberships) {
      const workspace = await ctx.db.get(membership.workspaceId);
      if (workspace)
        workspaces.push({ id: workspace._id, name: workspace.name, role: membership.role });
    }
    const descriptions: Record<string, string> = MCP_SCOPES;
    return {
      status: request.status,
      clientName: sanitizeClientName(request.clientName) ?? null,
      redirectHost,
      suggestedClient: suggestClient(request.redirectUri),
      scopes: request.scopes.map((name) => ({ name, description: descriptions[name] ?? name })),
      workspaces,
    };
  },
});

/**
 * Approves or denies a request as the signed-in person and returns the URL
 * to send the browser back to (the assistant's redirect URI).
 */
export const decideConsent = action({
  args: {
    requestId: v.string(),
    approve: v.boolean(),
    /** Required to approve. */
    workspaceId: v.optional(v.id("workspaces")),
    /** Required to approve; suggested by getConsentRequest. */
    client: v.optional(v.string()),
  },
  returns: v.object({ redirectUrl: v.string() }),
  handler: async (ctx, args): Promise<{ redirectUrl: string }> => {
    // Secrets come from an action's real randomness; mutations only see hashes.
    const code = args.approve ? randomSecret("mcp_ac_") : undefined;
    const decided: { redirectUri: string; state: string | null } = await ctx.runMutation(
      internal.oauth.recordConsent,
      {
        requestId: args.requestId,
        approve: args.approve,
        workspaceId: args.workspaceId,
        client: args.client,
        codeHash: code ? await sha256Hex(code) : undefined,
      },
    );
    const url = new URL(decided.redirectUri);
    if (code) {
      url.searchParams.set("code", code);
    } else {
      url.searchParams.set("error", "access_denied");
      url.searchParams.set("error_description", "The user denied access");
    }
    if (decided.state !== null) url.searchParams.set("state", decided.state);
    // RFC 9207: the issuer is the site origin (siteUrl unset on the component).
    url.searchParams.set("iss", mcpSiteUrl());
    return { redirectUrl: url.toString() };
  },
});

export const recordConsent = internalMutation({
  args: {
    requestId: v.string(),
    approve: v.boolean(),
    workspaceId: v.optional(v.id("workspaces")),
    client: v.optional(v.string()),
    codeHash: v.optional(v.string()),
  },
  returns: v.object({ redirectUri: v.string(), state: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    // The caller's own Convex Auth session, propagated from the action; an
    // agent can never approve its own access.
    await requireHumanSession(ctx);
    const user = await requireUser(ctx);
    const request = await ctx.runQuery(components.mcp.oauth.getAuthRequest, {
      requestId: args.requestId,
    });
    if (!request || request.kind !== "redirect" || request.status !== "pending")
      throw new ConvexError({ code: "REQUEST_EXPIRED" });

    let principal: string = user._id;
    if (args.approve) {
      if (!args.workspaceId || !args.codeHash)
        throw new ConvexError({ code: "INVALID_INPUT", field: "workspaceId" });
      const client = args.client ?? suggestClient(request.redirectUri);
      if (!isAgentClient(client))
        throw new ConvexError({ code: "INVALID_INPUT", field: "client" });
      // Only a member can connect an assistant to a workspace.
      await requireMembership(ctx, args.workspaceId);
      const now = Date.now();
      const actor = humanActor(user);
      const clientName = sanitizeClientName(request.clientName);
      const connectionId = await ctx.db.insert("agent_connections", {
        workspaceId: args.workspaceId,
        userId: user._id,
        client,
        authKind: "oauth",
        oauthClientName: clientName,
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
        summary: `${actor.label} connected a ${client} assistant`,
        actor,
      });
      principal = connectionId;
    }

    const decided = await ctx.runMutation(components.mcp.oauth.decideAuthRequest, {
      requestId: args.requestId,
      userId: principal,
      approved: args.approve,
      codeHash: args.codeHash,
      codeTtlMs: AUTH_CODE_TTL_MS,
    });
    // Expired or decided meanwhile: throwing also rolls back the connection.
    if (!decided || decided.kind !== "redirect")
      throw new ConvexError({ code: "REQUEST_EXPIRED" });
    return { redirectUri: decided.redirectUri, state: decided.state ?? null };
  },
});
