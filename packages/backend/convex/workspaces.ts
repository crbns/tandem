import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { createFolderCore } from "./lib/fs";
import { loadContext } from "./lib/ops";
import { contextApprovalValidator, contextValidator } from "./lib/validators";
import {
  ensureUser,
  humanActor,
  recordWorkspaceEvent,
  requireHumanSession,
  requireMembership,
  requireUser,
} from "./lib/auth";

const actorValidator = v.object({
  type: v.union(v.literal("human"), v.literal("agent"), v.literal("system")),
  userId: v.optional(v.id("users")),
  agentConnectionId: v.optional(v.id("agent_connections")),
  label: v.string(),
  client: v.optional(v.string()),
  userName: v.optional(v.string()),
});

export const initializeUser = mutation({
  args: {},
  returns: v.id("users"),
  handler: async (ctx) => await ensureUser(ctx),
});

export const createWorkspace = mutation({
  args: { name: v.string() },
  returns: v.id("workspaces"),
  handler: async (ctx, { name }) => {
    const userId = await ensureUser(ctx);
    if (!name.trim()) throw new ConvexError({ code: "INVALID_NAME" });
    const now = Date.now();
    const user = await ctx.db.get(userId);
    if (!user) throw new ConvexError({ code: "USER_NOT_INITIALIZED" });
    const actor = humanActor(user);
    const workspaceId = await ctx.db.insert("workspaces", {
      name: name.trim(),
      createdBy: userId,
      updatedBy: actor,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("workspace_members", {
      workspaceId,
      userId,
      role: "owner",
      updatedBy: actor,
      revision: 1,
      joinedAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("structured_context", {
      workspaceId,
      constraints: [],
      decisions: [],
      ownership: [],
      openQuestions: [],
      revision: 1,
      updatedAt: now,
      updatedBy: actor,
    });
    await recordWorkspaceEvent(ctx, {
      workspaceId,
      kind: "workspace.created",
      entityType: "workspace",
      entityId: workspaceId,
      summary: `Created workspace ${name.trim()}`,
      actor,
    });
    return workspaceId;
  },
});

export const listWorkspaces = query({
  args: {},
  returns: v.array(
    v.object({
      id: v.id("workspaces"),
      name: v.string(),
      role: v.union(
        v.literal("owner"),
        v.literal("admin"),
        v.literal("member"),
      ),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const memberships = await ctx.db
      .query("workspace_members")
      .withIndex("by_user_and_workspace", (q) => q.eq("userId", user._id))
      .take(100);
    const workspaces = await Promise.all(
      memberships.map(async (membership) => {
        const workspace = await ctx.db.get(membership.workspaceId);
        if (!workspace) return null;
        return {
          id: workspace._id,
          name: workspace.name,
          role: membership.role,
          updatedAt: workspace.updatedAt,
        };
      }),
    );
    return workspaces.filter((workspace) => workspace !== null);
  },
});

export const createFolder = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    parentId: v.optional(v.id("folders")),
    name: v.string(),
  },
  returns: v.id("folders"),
  handler: async (ctx, args) => {
    const { user } = await requireMembership(ctx, args.workspaceId);
    const folder = await createFolderCore(ctx, { ...args, actor: humanActor(user) });
    return folder._id;
  },
});

const inviteRole = v.union(v.literal("admin"), v.literal("member"));

async function hashInviteToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const createWorkspaceInvite = mutation({
  args: { workspaceId: v.id("workspaces"), role: inviteRole },
  returns: v.object({ inviteId: v.id("workspace_invites"), token: v.string(), expiresAt: v.number() }),
  handler: async (ctx, { workspaceId, role }) => {
    const { user, membership } = await requireMembership(ctx, workspaceId);
    if (membership.role !== "owner" && membership.role !== "admin")
      throw new ConvexError({ code: "FORBIDDEN" });
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const now = Date.now();
    const expiresAt = now + 7 * 24 * 60 * 60 * 1000;
    const actor = humanActor(user);
    const inviteId = await ctx.db.insert("workspace_invites", {
      workspaceId, tokenHash: await hashInviteToken(token), role,
      createdBy: user._id, createdAt: now, expiresAt,
      updatedBy: actor, revision: 1, updatedAt: now,
    });
    await recordWorkspaceEvent(ctx, {
      workspaceId, kind: "workspace.invite_created", entityType: "workspace_invite",
      entityId: inviteId, summary: `Created a ${role} invite`, actor,
    });
    return { inviteId, token, expiresAt };
  },
});

export const acceptWorkspaceInvite = mutation({
  args: { token: v.string() },
  returns: v.object({ workspaceId: v.id("workspaces") }),
  handler: async (ctx, { token }) => {
    const user = await requireUser(ctx);
    if (!/^[a-f0-9]{64}$/.test(token))
      throw new ConvexError({ code: "INVITE_INVALID" });
    const tokenHash = await hashInviteToken(token);
    const invite = await ctx.db.query("workspace_invites")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash)).unique();
    if (!invite) throw new ConvexError({ code: "INVITE_INVALID" });
    if (invite.revokedAt !== undefined) throw new ConvexError({ code: "INVITE_REVOKED" });
    if (invite.expiresAt <= Date.now()) throw new ConvexError({ code: "INVITE_EXPIRED" });
    if (invite.acceptedAt !== undefined) throw new ConvexError({ code: "INVITE_USED" });
    const { workspaceId } = invite;
    if (!await ctx.db.get(workspaceId)) throw new ConvexError({ code: "INVITE_INVALID" });
    const existing = await ctx.db.query("workspace_members")
      .withIndex("by_workspace_and_user", (q) => q.eq("workspaceId", workspaceId).eq("userId", user._id)).unique();
    if (existing) return { workspaceId };
    const now = Date.now();
    const actor = humanActor(user);
    const memberId = await ctx.db.insert("workspace_members", {
      workspaceId, userId: user._id, role: invite.role, updatedBy: actor,
      revision: 1, joinedAt: now, updatedAt: now,
    });
    await ctx.db.patch(invite._id, {
      acceptedBy: user._id, acceptedAt: now, updatedBy: actor,
      updatedAt: now, revision: invite.revision + 1,
    });
    await recordWorkspaceEvent(ctx, {
      workspaceId, kind: "workspace.member_added", entityType: "workspace_member",
      entityId: memberId, summary: `${actor.label} joined through an invite`, actor,
    });
    return { workspaceId };
  },
});

export const revokeWorkspaceInvite = mutation({
  args: { inviteId: v.id("workspace_invites") },
  returns: v.null(),
  handler: async (ctx, { inviteId }) => {
    // Check the invite's own workspace, never a client-supplied tenant ID.
    await requireUser(ctx);
    const invite = await ctx.db.get(inviteId);
    if (!invite) throw new ConvexError({ code: "INVITE_INVALID" });
    const { user, membership } = await requireMembership(ctx, invite.workspaceId);
    if (membership.role !== "owner" && membership.role !== "admin")
      throw new ConvexError({ code: "FORBIDDEN" });
    if (invite.revokedAt !== undefined) return null;
    const actor = humanActor(user);
    const now = Date.now();
    await ctx.db.patch(inviteId, {
      revokedAt: now, updatedAt: now, updatedBy: actor, revision: invite.revision + 1,
    });
    await recordWorkspaceEvent(ctx, {
      workspaceId: invite.workspaceId, kind: "workspace.invite_revoked", entityType: "workspace_invite",
      entityId: inviteId, summary: "Revoked a workspace invite", actor,
    });
    return null;
  },
});

export const listWorkspaceInvites = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(v.object({
    id: v.id("workspace_invites"), workspaceId: v.id("workspaces"), role: inviteRole,
    createdBy: v.id("users"), createdAt: v.number(), expiresAt: v.number(),
    acceptedBy: v.optional(v.id("users")), acceptedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()), updatedAt: v.number(),
  })),
  handler: async (ctx, { workspaceId }) => {
    const { membership } = await requireMembership(ctx, workspaceId);
    if (membership.role !== "owner" && membership.role !== "admin")
      throw new ConvexError({ code: "FORBIDDEN" });
    const invites = await ctx.db.query("workspace_invites")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).order("desc").take(100);
    return invites.map((invite) => ({
      id: invite._id, workspaceId, role: invite.role, createdBy: invite.createdBy,
      createdAt: invite.createdAt, expiresAt: invite.expiresAt, acceptedBy: invite.acceptedBy,
      acceptedAt: invite.acceptedAt, revokedAt: invite.revokedAt, updatedAt: invite.updatedAt,
    }));
  },
});

export const getWorkspaceInfo = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({
    id: v.id("workspaces"),
    name: v.string(),
    role: v.union(v.literal("owner"), v.literal("admin"), v.literal("member")),
    contextApproval: contextApprovalValidator,
    createdAt: v.number(),
    members: v.array(
      v.object({
        userId: v.id("users"),
        name: v.union(v.string(), v.null()),
        role: v.union(
          v.literal("owner"),
          v.literal("admin"),
          v.literal("member"),
        ),
        joinedAt: v.number(),
      }),
    ),
    recentEvents: v.array(
      v.object({
        id: v.id("workspace_events"),
        kind: v.string(),
        summary: v.string(),
        actorLabel: v.string(),
        createdAt: v.number(),
      }),
    ),
  }),
  handler: async (ctx, { workspaceId }) => {
    const { membership } = await requireMembership(ctx, workspaceId);
    const workspace = await ctx.db.get(workspaceId);
    if (!workspace) throw new ConvexError({ code: "WORKSPACE_NOT_FOUND" });
    const memberships = await ctx.db
      .query("workspace_members")
      .withIndex("by_workspace_and_user", (q) =>
        q.eq("workspaceId", workspaceId),
      )
      .take(100);
    const members = await Promise.all(
      memberships.map(async (member) => {
        const user = await ctx.db.get(member.userId);
        return {
          userId: member.userId,
          // Email tells nameless members apart; null only when both are missing.
          name: user?.name ?? user?.email ?? null,
          role: member.role,
          joinedAt: member.joinedAt,
        };
      }),
    );
    const events = await ctx.db
      .query("workspace_events")
      .withIndex("by_workspace_and_created", (q) =>
        q.eq("workspaceId", workspaceId),
      )
      .order("desc")
      .take(20);
    return {
      id: workspace._id,
      name: workspace.name,
      role: membership.role,
      contextApproval: workspace.contextApproval ?? "manual",
      createdAt: workspace.createdAt,
      members,
      recentEvents: events.map((event) => ({
        id: event._id,
        kind: event.kind,
        summary: event.summary,
        actorLabel: event.actor.label,
        createdAt: event.createdAt,
      })),
    };
  },
});

/**
 * Owners and admins choose whether context proposals wait for approval.
 * Proposals already pending stay pending either way.
 */
export const setContextApproval = mutation({
  args: { workspaceId: v.id("workspaces"), mode: contextApprovalValidator },
  returns: v.null(),
  handler: async (ctx, { workspaceId, mode }) => {
    await requireHumanSession(ctx);
    const { user, membership } = await requireMembership(ctx, workspaceId);
    if (membership.role !== "owner" && membership.role !== "admin")
      throw new ConvexError({ code: "FORBIDDEN" });
    const workspace = await ctx.db.get(workspaceId);
    if (!workspace) throw new ConvexError({ code: "WORKSPACE_NOT_FOUND" });
    if ((workspace.contextApproval ?? "manual") === mode) return null;
    const actor = humanActor(user);
    await ctx.db.patch(workspaceId, {
      contextApproval: mode,
      updatedBy: actor,
      revision: workspace.revision + 1,
      updatedAt: Date.now(),
    });
    await recordWorkspaceEvent(ctx, {
      workspaceId, kind: "workspace.context_approval_changed", entityType: "workspace",
      entityId: workspaceId,
      summary: mode === "automatic"
        ? "Set context changes to apply automatically"
        : "Set context changes to need manual approval",
      actor,
    });
    return null;
  },
});

export const getWorkspaceContext = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(contextValidator, v.null()),
  handler: async (ctx, { workspaceId }) => {
    await requireMembership(ctx, workspaceId);
    const row = await ctx.db.query("structured_context")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).unique();
    return row ? loadContext(ctx, workspaceId) : null;
  },
});
