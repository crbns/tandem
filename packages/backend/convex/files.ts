import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  humanActor,
  recordWorkspaceEvent,
  requireMembership,
  requireUser,
} from "./lib/auth";
import {
  createDocumentCore,
  renameFileCore,
  deleteFileCore,
  toFileMetadata,
  updateDocumentCore,
} from "./lib/ops";

import { validateBinaryUpload } from "./lib/binaries";
import { MAX_NAME_LENGTH, nameKey, storedName } from "./lib/names";

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

/** Restore content by appending a revision; prior revisions remain immutable. */
export const restoreRevision = mutation({
  args: {
    fileId: v.id("files"),
    version: v.number(),
    expectedVersion: v.number(),
  },
  returns: fileValidator,
  handler: async (ctx, args) => {
    const file = await getAuthorizedFile(ctx, args.fileId);
    const user = await requireUser(ctx);
    if (!Number.isSafeInteger(args.version) || args.version < 1)
      throw new ConvexError({ code: "INVALID_INPUT" });
    const revision = await ctx.db
      .query("file_revisions")
      .withIndex("by_file_and_version", (q) =>
        q.eq("fileId", file._id).eq("version", args.version),
      )
      .unique();
    if (!revision) throw new ConvexError({ code: "INVALID_INPUT" });
    const updated = await updateDocumentCore(ctx, {
      file,
      content: revision.content,
      expectedVersion: args.expectedVersion,
      actor: humanActor(user),
      eventSummary: `Restored v${args.version} as v${file.version + 1} for ${file.name}`,
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

/** Only members can obtain a storage upload URL; publication validates the stored blob. */
export const generateUploadUrl = mutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.string(),
  handler: async (ctx, { workspaceId }) => {
    await requireMembership(ctx, workspaceId);
    return await ctx.storage.generateUploadUrl();
  },
});

export const finalizeUpload = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    storageId: v.id("_storage"),
    name: v.string(),
    fileId: v.optional(v.id("files")),
    expectedVersion: v.optional(v.number()),
  },
  returns: fileValidator,
  handler: async (ctx, args) => {
    const { user } = await requireMembership(ctx, args.workspaceId);
    const actor = humanActor(user);
    const metadata = await ctx.db.system.get("_storage", args.storageId);
    if (!metadata) throw new ConvexError({ code: "UPLOAD_NOT_FOUND" });
    const mimeType = validateBinaryUpload(metadata.size, metadata.contentType);
    const used = await ctx.db
      .query("storage_objects")
      .withIndex("by_storage_id", (q) => q.eq("storageId", args.storageId))
      .first();
    if (used) throw new ConvexError({ code: "UPLOAD_ALREADY_FINALIZED" });
    const now = Date.now();
    let fileId: Id<"files">;
    let version = 1;
    let name: string;
    if (args.fileId) {
      const file = await ctx.db.get(args.fileId);
      if (!file || file.deletedAt !== undefined || file.workspaceId !== args.workspaceId)
        throw new ConvexError({ code: "FILE_NOT_FOUND" });
      if (!file.storageId) throw new ConvexError({ code: "NOT_BINARY_FILE" });
      if (
        !Number.isSafeInteger(args.expectedVersion) ||
        args.expectedVersion! < 1
      )
        throw new ConvexError({ code: "INVALID_INPUT" });
      if (args.expectedVersion !== file.version)
        throw new ConvexError({
          code: "VERSION_CONFLICT",
          currentVersion: file.version,
          expectedVersion: args.expectedVersion,
        });
      fileId = file._id;
      name = file.name;
      version = file.version + 1;
      await ctx.db.patch(fileId, {
        storageId: args.storageId,
        mimeType,
        version,
        revision: file.revision + 1,
        updatedBy: actor,
        updatedAt: now,
      });
    } else {
      if (args.expectedVersion !== undefined)
        throw new ConvexError({ code: "INVALID_INPUT" });
      name = storedName(args.name);
      const key = nameKey(name);
      if (!key || name.length > MAX_NAME_LENGTH)
        throw new ConvexError({ code: "INVALID_NAME" });
      const existing = await ctx.db
        .query("files")
        .withIndex("by_workspace_and_parent_and_name_key", (q) =>
          q
            .eq("workspaceId", args.workspaceId)
            .eq("parentId", undefined)
            .eq("nameKey", key),
        )
        .first();
      if (existing)
        throw new ConvexError({
          code: "NAME_EXISTS",
          fileId: existing._id,
          currentVersion: existing.version,
        });
      fileId = await ctx.db.insert("files", {
        workspaceId: args.workspaceId,
        name,
        nameKey: key,
        mimeType,
        storageId: args.storageId,
        version,
        revision: 1,
        createdBy: actor,
        updatedBy: actor,
        createdAt: now,
        updatedAt: now,
      });
    }
    await ctx.db.insert("file_revisions", {
      workspaceId: args.workspaceId,
      fileId,
      version,
      content: "",
      storageId: args.storageId,
      mimeType,
      size: metadata.size,
      actor,
      createdAt: now,
    });
    await ctx.db.insert("storage_objects", {
      workspaceId: args.workspaceId,
      fileId,
      storageId: args.storageId,
      fileName: name,
      mimeType,
      size: metadata.size,
      uploadedBy: actor,
      updatedBy: actor,
      revision: version,
      createdAt: now,
    });
    await recordWorkspaceEvent(ctx, {
      workspaceId: args.workspaceId,
      kind: version === 1 ? "file.created" : "file.updated",
      entityType: "file",
      entityId: fileId,
      summary: `Uploaded ${name} revision ${version}`,
      actor,
    });
    const file = await ctx.db.get(fileId);
    if (!file) throw new ConvexError({ code: "FILE_NOT_FOUND" });
    return toMetadata(file);
  },
});

/** Resolves a private blob for the HTTP action after checking the caller's membership. */
export const getBinaryContent = internalQuery({
  args: { fileId: v.string(), version: v.optional(v.number()) },
  returns: v.object({
    storageId: v.id("_storage"),
    mimeType: v.string(),
    name: v.string(),
  }),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const id = ctx.db.normalizeId("files", args.fileId);
    const file = id ? await ctx.db.get(id) : null;
    if (!file || file.deletedAt !== undefined) throw new ConvexError({ code: "FILE_NOT_FOUND" });
    await requireMembership(ctx, file.workspaceId);
    if (
      args.version !== undefined &&
      (!Number.isSafeInteger(args.version) || args.version < 1)
    )
      throw new ConvexError({ code: "INVALID_INPUT" });
    const revision =
      args.version === undefined
        ? null
        : await ctx.db
            .query("file_revisions")
            .withIndex("by_file_and_version", (q) =>
              q.eq("fileId", file._id).eq("version", args.version!),
            )
            .unique();
    const storageId =
      args.version === undefined ? file.storageId : revision?.storageId;
    if (!storageId) throw new ConvexError({ code: "FILE_NOT_FOUND" });
    return {
      storageId,
      mimeType: revision?.mimeType ?? file.mimeType,
      name: file.name,
    };
  },
});
