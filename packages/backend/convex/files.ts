import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  humanActor,
  recordWorkspaceEvent,
  requireMembership,
  requireUser,
} from "./lib/auth";

const actorValidator = v.object({
  type: v.union(v.literal("human"), v.literal("agent"), v.literal("system")),
  userId: v.optional(v.id("users")),
  agentConnectionId: v.optional(v.id("agent_connections")),
  label: v.string(),
});

const fileValidator = v.object({
  id: v.id("files"),
  workspaceId: v.id("workspaces"),
  parentId: v.union(v.id("folders"), v.null()),
  name: v.string(),
  mimeType: v.string(),
  version: v.number(),
  updatedAt: v.number(),
  updatedBy: actorValidator,
});

function toMetadata(file: Doc<"files">) {
  return {
    id: file._id,
    workspaceId: file.workspaceId,
    parentId: file.parentId ?? null,
    name: file.name,
    mimeType: file.mimeType,
    version: file.version,
    updatedAt: file.updatedAt,
    updatedBy: file.updatedBy,
  };
}

async function getAuthorizedFile(
  ctx: Parameters<typeof requireUser>[0],
  fileId: Id<"files">,
) {
  const user = await requireUser(ctx);
  const file = await ctx.db.get(fileId);
  if (!file) throw new Error("FILE_NOT_FOUND");
  const membership = await ctx.db
    .query("workspace_members")
    .withIndex("by_workspace_and_user", (q) =>
      q.eq("workspaceId", file.workspaceId).eq("userId", user._id),
    )
    .unique();
  // Keep another tenant's file indistinguishable from a missing file.
  if (!membership) throw new Error("FILE_NOT_FOUND");
  return file;
}

export const listFiles = query({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    folderId: v.optional(v.id("folders")),
    query: v.optional(v.string()),
  },
  returns: v.array(fileValidator),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    let workspaceId = args.workspaceId;
    if (!workspaceId) {
      const membership = await ctx.db
        .query("workspace_members")
        .withIndex("by_user_and_workspace", (q) => q.eq("userId", user._id))
        .first();
      if (!membership) throw new Error("FORBIDDEN");
      workspaceId = membership.workspaceId;
    }
    await requireMembership(ctx, workspaceId);
    const rows = args.folderId
      ? await ctx.db
          .query("files")
          .withIndex("by_workspace_and_parent", (q) =>
            q.eq("workspaceId", workspaceId!).eq("parentId", args.folderId),
          )
          .take(100)
      : await ctx.db
          .query("files")
          .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId!))
          .take(100);
    const needle = args.query?.trim().toLocaleLowerCase();
    return rows
      .filter(
        (file) => !needle || file.name.toLocaleLowerCase().includes(needle),
      )
      .map(toMetadata);
  },
});

export const readFile = query({
  args: { fileId: v.id("files") },
  returns: v.object({
    file: fileValidator,
    content: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { fileId }) => {
    const file = await getAuthorizedFile(ctx, fileId);
    return { file: toMetadata(file), content: file.content ?? null };
  },
});

export const createDocument = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    parentId: v.optional(v.id("folders")),
    name: v.string(),
    mimeType: v.string(),
    content: v.string(),
  },
  returns: fileValidator,
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    let workspaceId = args.workspaceId;
    if (!workspaceId) {
      const membership = await ctx.db
        .query("workspace_members")
        .withIndex("by_user_and_workspace", (q) => q.eq("userId", user._id))
        .first();
      if (!membership) throw new Error("FORBIDDEN");
      workspaceId = membership.workspaceId;
    }
    await requireMembership(ctx, workspaceId);
    if (args.parentId) {
      const folder = await ctx.db.get(args.parentId);
      if (!folder || folder.workspaceId !== workspaceId)
        throw new Error("INVALID_PARENT_FOLDER");
    }
    if (!args.name.trim()) throw new Error("INVALID_NAME");
    const now = Date.now();
    const actor = humanActor(user);
    const fileId = await ctx.db.insert("files", {
      workspaceId,
      parentId: args.parentId,
      name: args.name.trim(),
      mimeType: args.mimeType,
      content: args.content,
      version: 1,
      createdBy: actor,
      updatedBy: actor,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("file_revisions", {
      workspaceId,
      fileId,
      version: 1,
      content: args.content,
      actor,
      createdAt: now,
    });
    await recordWorkspaceEvent(ctx, {
      workspaceId,
      kind: "file.created",
      entityType: "file",
      entityId: fileId,
      summary: `Created ${args.name.trim()}`,
      actor,
    });
    const file = await ctx.db.get(fileId);
    if (!file) throw new Error("FILE_NOT_FOUND");
    return toMetadata(file);
  },
});

export const updateDocument = mutation({
  args: {
    fileId: v.id("files"),
    content: v.string(),
    expectedVersion: v.number(),
  },
  returns: fileValidator,
  handler: async (ctx, args) => {
    const file = await getAuthorizedFile(ctx, args.fileId);
    if (file.version !== args.expectedVersion) {
      throw new Error(
        `VERSION_CONFLICT: current version is ${file.version}; expected ${args.expectedVersion}`,
      );
    }
    const user = await requireUser(ctx);
    const actor = humanActor(user);
    const now = Date.now();
    const version = file.version + 1;
    await ctx.db.patch(file._id, {
      content: args.content,
      version,
      updatedBy: actor,
      revision: file.revision + 1,
      updatedAt: now,
    });
    await ctx.db.insert("file_revisions", {
      workspaceId: file.workspaceId,
      fileId: file._id,
      version,
      content: args.content,
      actor,
      createdAt: now,
    });
    await recordWorkspaceEvent(ctx, {
      workspaceId: file.workspaceId,
      kind: "file.updated",
      entityType: "file",
      entityId: file._id,
      summary: `Updated ${file.name} to revision ${version}`,
      actor,
    });
    const updated = await ctx.db.get(file._id);
    if (!updated) throw new Error("FILE_NOT_FOUND");
    return toMetadata(updated);
  },
});

export const getFileVersions = query({
  args: { fileId: v.id("files"), limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      id: v.id("file_revisions"),
      version: v.number(),
      content: v.string(),
      actor: actorValidator,
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const file = await getAuthorizedFile(ctx, args.fileId);
    const revisions = await ctx.db
      .query("file_revisions")
      .withIndex("by_file_and_version", (q) => q.eq("fileId", file._id))
      .order("desc")
      .take(Math.min(Math.max(args.limit ?? 20, 1), 100));
    return revisions.map(({ _id, version, content, actor, createdAt }) => ({
      id: _id,
      version,
      content,
      actor,
      createdAt,
    }));
  },
});
