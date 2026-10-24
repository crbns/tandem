import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { humanActor, requireMembership, requireUser } from "./lib/auth";
import {
  createDocumentCore,
  renameFileCore,
  deleteFileCore,
  toFileMetadata,
  updateDocumentCore,
} from "./lib/ops";

const actorValidator = v.object({
  type: v.union(v.literal("human"), v.literal("agent"), v.literal("system")),
  userId: v.optional(v.id("users")),
  agentConnectionId: v.optional(v.id("agent_connections")),
  label: v.string(),
  client: v.optional(v.string()),
  userName: v.optional(v.string()),
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

const toMetadata = toFileMetadata;

async function getAuthorizedFile(
  ctx: Parameters<typeof requireUser>[0],
  fileId: Id<"files">,
) {
  const user = await requireUser(ctx);
  const file = await ctx.db.get(fileId);
  if (!file || file.deletedAt !== undefined) throw new ConvexError({ code: "FILE_NOT_FOUND" });
  const membership = await ctx.db
    .query("workspace_members")
    .withIndex("by_workspace_and_user", (q) =>
      q.eq("workspaceId", file.workspaceId).eq("userId", user._id),
    )
    .unique();
  // Keep another tenant's file indistinguishable from a missing file.
  if (!membership) throw new ConvexError({ code: "FILE_NOT_FOUND" });
  return file;
}

export const listFiles = query({
  args: {
    workspaceId: v.id("workspaces"),
    folderId: v.optional(v.id("folders")),
    query: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(fileValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const workspaceId = args.workspaceId;
    await requireMembership(ctx, workspaceId);
    const requested = args.paginationOpts.numItems;
    if (!Number.isInteger(requested) || requested < 1 || requested > 200)
      throw new ConvexError({ code: "INVALID_INPUT" });
    const needle = args.query?.trim();
    const rows = needle
      ? ctx.db.query("files").withSearchIndex("search_name", (q) => {
          const search = q.search("name", needle).eq("workspaceId", workspaceId!).eq("deletedAt", undefined);
          return args.folderId ? search.eq("parentId", args.folderId) : search;
        })
      : args.folderId
        ? ctx.db.query("files").withIndex("by_workspace_and_deleted_at_and_parent", (q) =>
            q.eq("workspaceId", workspaceId!).eq("deletedAt", undefined).eq("parentId", args.folderId),
          )
        : ctx.db.query("files").withIndex("by_workspace_and_deleted_at_and_updated_at", (q) => q.eq("workspaceId", workspaceId!).eq("deletedAt", undefined));
    const result = await rows.paginate(args.paginationOpts);
    return {
      page: result.page.map(toMetadata),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
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
    workspaceId: v.id("workspaces"),
    parentId: v.optional(v.id("folders")),
    name: v.string(),
    mimeType: v.string(),
    content: v.string(),
  },
  returns: fileValidator,
  handler: async (ctx, args) => {
    const { user } = await requireMembership(ctx, args.workspaceId);
    const file = await createDocumentCore(ctx, {
      ...args,
      actor: humanActor(user),
    });
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
    const user = await requireUser(ctx);
    const updated = await updateDocumentCore(ctx, {
      file,
      content: args.content,
      expectedVersion: args.expectedVersion,
      actor: humanActor(user),
    });
    return toMetadata(updated);
  },
});

export const getFileVersions = query({
  args: { fileId: v.id("files"), limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      id: v.id("file_revisions"),
      version: v.number(),
      content: v.optional(v.string()),
      actor: actorValidator,
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const file = await getAuthorizedFile(ctx, args.fileId);
    const requestedLimit = args.limit ?? 20;
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.floor(requestedLimit), 1), 100)
      : 20;
    const revisions = await ctx.db
      .query("file_revisions")
      .withIndex("by_file_and_version", (q) => q.eq("fileId", file._id))
      .order("desc")
      .take(limit);
    // Keep history metadata bounded. The selected revision's content is read
    // separately through getFileRevision.
    return revisions.map(({ _id, version, actor, createdAt }) => ({
      id: _id,
      version,
      actor,
      createdAt,
    }));
  },
});

export const getFileRevision = query({
  args: { fileId: v.id("files"), version: v.number() },
  returns: v.union(
    v.object({
      id: v.id("file_revisions"),
      version: v.number(),
      content: v.string(),
      actor: actorValidator,
      createdAt: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, { fileId, version }) => {
    const file = await getAuthorizedFile(ctx, fileId);
    const revision = await ctx.db
      .query("file_revisions")
      .withIndex("by_file_and_version", (q) =>
        q.eq("fileId", file._id).eq("version", version),
      )
      .unique();
    if (!revision) return null;
    return {
      id: revision._id,
      version: revision.version,
      content: revision.content,
      actor: revision.actor,
      createdAt: revision.createdAt,
    };
  },
});

export const renameFile = mutation({
  args: { fileId: v.id("files"), name: v.string(), expectedVersion: v.number() },
  returns: fileValidator,
  handler: async (ctx, args) => {
    const file = await getAuthorizedFile(ctx, args.fileId);
    const user = await requireUser(ctx);
    return toMetadata(await renameFileCore(ctx, { ...args, file, actor: humanActor(user) }));
  },
});

export const deleteFile = mutation({
  args: { fileId: v.id("files"), expectedVersion: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const file = await getAuthorizedFile(ctx, args.fileId);
    const user = await requireUser(ctx);
    await deleteFileCore(ctx, { ...args, file, actor: humanActor(user) });
    return null;
  },
});
