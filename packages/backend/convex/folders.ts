import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { humanActor, requireMembership, requireUser } from "./lib/auth";
import {
  MAX_DIRECTORY_CHILDREN,
  breadcrumbs,
  createFolderCore,
  deleteFolderCore,
  fileRowValidator,
  folderPath,
  folderRowValidator,
  joinPath,
  listChildFiles,
  listChildFolders,
  loadFolderIndex,
  moveFolderCore,
  renameFolderCore,
  toFileRow,
  toFolderRow,
} from "./lib/fs";

async function getAuthorizedFolder(
  ctx: Parameters<typeof requireUser>[0],
  folderId: Id<"folders">,
) {
  const user = await requireUser(ctx);
  const folder = await ctx.db.get(folderId);
  if (!folder || folder.deletedAt !== undefined)
    throw new ConvexError({ code: "FOLDER_NOT_FOUND", folderId });
  const membership = await ctx.db
    .query("workspace_members")
    .withIndex("by_workspace_and_user", (q) =>
      q.eq("workspaceId", folder.workspaceId).eq("userId", user._id),
    )
    .unique();
  // Keep another tenant's folder indistinguishable from a missing folder.
  if (!membership) throw new ConvexError({ code: "FOLDER_NOT_FOUND", folderId });
  return { user, folder };
}

async function folderRow(ctx: Parameters<typeof folderPath>[0], folder: Doc<"folders">) {
  return toFolderRow(folder, await folderPath(ctx, folder._id));
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

/** Immediate children of a folder (root when folderId is absent), folders first. */
export const listDirectory = query({
  args: {
    workspaceId: v.id("workspaces"),
    folderId: v.optional(v.id("folders")),
  },
  returns: v.object({
    folder: v.union(folderRowValidator, v.null()),
    breadcrumbs: v.array(v.object({ id: v.id("folders"), name: v.string() })),
    folders: v.array(folderRowValidator),
    files: v.array(fileRowValidator),
  }),
  handler: async (ctx, { workspaceId, folderId }) => {
    await requireMembership(ctx, workspaceId);
    let folder: Doc<"folders"> | null = null;
    if (folderId) {
      folder = await ctx.db.get(folderId);
      if (!folder || folder.deletedAt !== undefined || folder.workspaceId !== workspaceId)
        throw new ConvexError({ code: "FOLDER_NOT_FOUND", folderId });
    }
    const base = await folderPath(ctx, folder?._id);
    const folders = await listChildFolders(ctx, workspaceId, folder?._id, MAX_DIRECTORY_CHILDREN);
    const files = await listChildFiles(ctx, workspaceId, folder?._id, MAX_DIRECTORY_CHILDREN);
    return {
      folder: folder ? toFolderRow(folder, base) : null,
      breadcrumbs: await breadcrumbs(ctx, folder),
      folders: folders
        .sort(byName)
        .map((f) => toFolderRow(f, joinPath(base, f.name))),
      files: files.sort(byName).map((f) => toFileRow(f, joinPath(base, f.name))),
    };
  },
});

/** Every live folder, sorted by path, for the sidebar tree and move picker. */
export const listFolderTree = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(folderRowValidator),
  handler: async (ctx, { workspaceId }) => {
    await requireMembership(ctx, workspaceId);
    const index = await loadFolderIndex(ctx, workspaceId);
    return index.folders
      .map((f) => toFolderRow(f, index.folderPath(f._id)))
      .sort((a, b) => byName({ name: a.path }, { name: b.path }));
  },
});

export const createFolder = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    parentId: v.optional(v.id("folders")),
    name: v.string(),
  },
  returns: folderRowValidator,
  handler: async (ctx, args) => {
    const { user } = await requireMembership(ctx, args.workspaceId);
    const folder = await createFolderCore(ctx, { ...args, actor: humanActor(user) });
    return await folderRow(ctx, folder);
  },
});

export const renameFolder = mutation({
  args: {
    folderId: v.id("folders"),
    name: v.string(),
    expectedRevision: v.number(),
  },
  returns: folderRowValidator,
  handler: async (ctx, args) => {
    const { user, folder } = await getAuthorizedFolder(ctx, args.folderId);
    const renamed = await renameFolderCore(ctx, {
      folder,
      name: args.name,
      expectedRevision: args.expectedRevision,
      actor: humanActor(user),
    });
    return await folderRow(ctx, renamed);
  },
});

export const moveFolder = mutation({
  args: {
    folderId: v.id("folders"),
    parentId: v.union(v.id("folders"), v.null()),
    expectedRevision: v.number(),
  },
  returns: folderRowValidator,
  handler: async (ctx, args) => {
    const { user, folder } = await getAuthorizedFolder(ctx, args.folderId);
    const moved = await moveFolderCore(ctx, {
      folder,
      parentId: args.parentId,
      expectedRevision: args.expectedRevision,
      actor: humanActor(user),
    });
    return await folderRow(ctx, moved);
  },
});

/** Recursive soft delete; history is kept and names are released. */
export const deleteFolder = mutation({
  args: { folderId: v.id("folders"), expectedRevision: v.number() },
  returns: v.object({ deletedFiles: v.number(), deletedFolders: v.number() }),
  handler: async (ctx, args) => {
    const { user, folder } = await getAuthorizedFolder(ctx, args.folderId);
    return await deleteFolderCore(ctx, {
      folder,
      expectedRevision: args.expectedRevision,
      actor: humanActor(user),
    });
  },
});
