import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  ensureUser,
  humanActor,
  recordWorkspaceEvent,
  requireMembership,
  requireUser,
} from "./lib/auth";

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
    if (!name.trim()) throw new Error("INVALID_NAME");
    const now = Date.now();
    const user = await ctx.db.get(userId);
    if (!user) throw new Error("USER_NOT_INITIALIZED");
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
    if (!args.name.trim()) throw new Error("INVALID_NAME");
    if (args.parentId) {
      const parent = await ctx.db.get(args.parentId);
      if (!parent || parent.workspaceId !== args.workspaceId)
        throw new Error("INVALID_PARENT_FOLDER");
    }
    const now = Date.now();
    const actor = humanActor(user);
    const folderId = await ctx.db.insert("folders", {
      workspaceId: args.workspaceId,
      parentId: args.parentId,
      name: args.name.trim(),
      createdBy: actor,
      updatedBy: actor,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    await recordWorkspaceEvent(ctx, {
      workspaceId: args.workspaceId,
      kind: "folder.created",
      entityType: "folder",
      entityId: folderId,
      summary: `Created folder ${args.name.trim()}`,
      actor,
    });
    return folderId;
  },
});

export const addWorkspaceMember = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    email: v.string(),
  },
  returns: v.id("workspace_members"),
  handler: async (ctx, args) => {
    const { user, membership } = await requireMembership(ctx, args.workspaceId);
    if (membership.role !== "owner" && membership.role !== "admin")
      throw new Error("FORBIDDEN");
    const email = args.email.trim().toLocaleLowerCase();
    if (!email) throw new Error("INVALID_EMAIL");
    const invitee = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .unique();
    if (!invitee) throw new Error("USER_NOT_REGISTERED");
    if (!invitee.emailVerificationTime) throw new Error("USER_EMAIL_NOT_VERIFIED");
    const existing = await ctx.db
      .query("workspace_members")
      .withIndex("by_workspace_and_user", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("userId", invitee._id),
      )
      .unique();
    if (existing) return existing._id;
    const now = Date.now();
    const memberId = await ctx.db.insert("workspace_members", {
      workspaceId: args.workspaceId,
      userId: invitee._id,
      role: "member",
      updatedBy: humanActor(user),
      revision: 1,
      joinedAt: now,
      updatedAt: now,
    });
    await recordWorkspaceEvent(ctx, {
      workspaceId: args.workspaceId,
      kind: "workspace.member_added",
      entityType: "workspace_member",
      entityId: memberId,
      summary: `Added ${invitee.name ?? invitee.email ?? "a member"} to the workspace`,
      actor: humanActor(user),
    });
    return memberId;
  },
});

export const getWorkspaceInfo = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({
    id: v.id("workspaces"),
    name: v.string(),
    role: v.union(v.literal("owner"), v.literal("admin"), v.literal("member")),
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
    if (!workspace) throw new Error("WORKSPACE_NOT_FOUND");
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
          name: user?.name ?? null,
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

export const getWorkspaceContext = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(
    v.object({
      goal: v.union(
        v.object({
          text: v.string(),
          sourceFileIds: v.array(v.id("files")),
          updatedAt: v.number(),
        }),
        v.null(),
      ),
      scope: v.union(
        v.object({
          text: v.string(),
          sourceFileIds: v.array(v.id("files")),
          updatedAt: v.number(),
        }),
        v.null(),
      ),
      constraints: v.array(
        v.object({
          text: v.string(),
          sourceFileIds: v.array(v.id("files")),
          updatedAt: v.number(),
        }),
      ),
      decisions: v.array(
        v.object({
          text: v.string(),
          sourceFileIds: v.array(v.id("files")),
          updatedAt: v.number(),
        }),
      ),
      ownership: v.array(
        v.object({
          text: v.string(),
          sourceFileIds: v.array(v.id("files")),
          updatedAt: v.number(),
        }),
      ),
      openQuestions: v.array(
        v.object({
          text: v.string(),
          sourceFileIds: v.array(v.id("files")),
          updatedAt: v.number(),
        }),
      ),
      revision: v.number(),
      updatedAt: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, { workspaceId }) => {
    await requireMembership(ctx, workspaceId);
    const context = await ctx.db
      .query("structured_context")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    if (!context) return null;
    const compact = (
      value:
        | { text: string; sourceFileIds: Id<"files">[]; updatedAt: number }
        | undefined,
    ) =>
      value
        ? {
            text: value.text,
            sourceFileIds: value.sourceFileIds,
            updatedAt: value.updatedAt,
          }
        : null;
    const compactList = (
      values: {
        text: string;
        sourceFileIds: Id<"files">[];
        updatedAt: number;
      }[],
    ) =>
      values.map(({ text, sourceFileIds, updatedAt }) => ({
        text,
        sourceFileIds,
        updatedAt,
      }));
    return {
      goal: compact(context.goal),
      scope: compact(context.scope),
      constraints: compactList(context.constraints),
      decisions: compactList(context.decisions),
      ownership: compactList(context.ownership),
      openQuestions: compactList(context.openQuestions),
      revision: context.revision,
      updatedAt: context.updatedAt,
    };
  },
});
