// Workspace file system: nested folders, paths and moves (docs/filesystem.md).
// Shared by the dashboard (convex/folders.ts, files.ts) and the MCP tools
// (mcpTools.ts). Callers authorize first and pass a verified actor.
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { type Actor, recordWorkspaceEvent } from "./auth";
import { isValidName, nameKey, storedName } from "./names";
import { actorValidator, fileMetadataValidator } from "./validators";

type ReadCtx = QueryCtx | MutationCtx;
type FolderId = Id<"folders">;

/** At most this many nested folders, root excluded (FOLDER_TOO_DEEP). */
export const MAX_FOLDER_DEPTH = 32;
/** Folders plus files one deleteFolder call may soft-delete (FOLDER_TOO_LARGE). */
export const MAX_DELETE_ITEMS = 500;
/** Children of each kind returned for one directory listing. */
export const MAX_DIRECTORY_CHILDREN = 500;
/** Live folders read by loadFolderIndex. */
export const MAX_INDEXED_FOLDERS = 2000;
// Rows scanned per parent when looking for legacy rows without a nameKey.
const LEGACY_SCAN_LIMIT = 500;

// ---------------------------------------------------------------------------
// Row shapes

export function toFileMetadata(file: Doc<"files">) {
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

/** FileRow: the existing file metadata plus its path. */
export function toFileRow(file: Doc<"files">, path: string) {
  return { ...toFileMetadata(file), path };
}

export function toFolderRow(folder: Doc<"folders">, path: string) {
  return {
    id: folder._id,
    workspaceId: folder.workspaceId,
    parentId: folder.parentId ?? null,
    name: folder.name,
    path,
    revision: folder.revision,
    updatedAt: folder.updatedAt,
    updatedBy: folder.updatedBy,
  };
}

export type FileRow = ReturnType<typeof toFileRow>;
export type FolderRow = ReturnType<typeof toFolderRow>;

export const fileRowValidator = fileMetadataValidator.extend({
  path: v.string(),
});

export const folderRowValidator = v.object({
  id: v.id("folders"),
  workspaceId: v.id("workspaces"),
  parentId: v.union(v.id("folders"), v.null()),
  name: v.string(),
  path: v.string(),
  revision: v.number(),
  updatedAt: v.number(),
  updatedBy: actorValidator,
});

// ---------------------------------------------------------------------------
// Names, paths and lookups

/** Stored name and collision key for a new name, or INVALID_NAME. */
export function requireValidName(raw: string): { name: string; key: string } {
  const name = storedName(raw);
  if (!isValidName(name)) throw new ConvexError({ code: "INVALID_NAME" });
  return { name, key: nameKey(name) };
}

export function joinPath(parentPath: string, name: string): string {
  return parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
}

/**
 * Path segments (stored names) of a workspace path. "" and "/" are root ([]).
 * The leading "/" is optional and one trailing "/" is ignored; empty
 * segments, "." and ".." are INVALID_PATH.
 */
export function splitPath(path: string): string[] {
  let rest = path.trim();
  if (rest.startsWith("/")) rest = rest.slice(1);
  if (rest.endsWith("/")) rest = rest.slice(0, -1);
  if (rest === "") return [];
  const segments = rest.split("/").map(storedName);
  if (
    segments.length > MAX_FOLDER_DEPTH + 1 ||
    segments.some((s) => nameKey(s) === "" || s === "." || s === "..")
  )
    throw new ConvexError({ code: "INVALID_PATH", path });
  return segments;
}

function folderKey(folder: Doc<"folders">): string {
  return folder.nameKey ?? nameKey(folder.name);
}

/** The live folder named `key` directly under `parentId` (root when undefined). */
export async function findChildFolder(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
  parentId: FolderId | undefined,
  key: string,
): Promise<Doc<"folders"> | null> {
  const keyed = await ctx.db
    .query("folders")
    .withIndex("by_workspace_and_parent_and_name_key", (q) =>
      q.eq("workspaceId", workspaceId).eq("parentId", parentId).eq("nameKey", key),
    )
    .first();
  if (keyed) return keyed;
  // Legacy folders have no stored key; deleted folders released theirs.
  const unkeyed = await ctx.db
    .query("folders")
    .withIndex("by_workspace_and_parent_and_name_key", (q) =>
      q.eq("workspaceId", workspaceId).eq("parentId", parentId).eq("nameKey", undefined),
    )
    .take(LEGACY_SCAN_LIMIT);
  return (
    unkeyed.find((f) => f.deletedAt === undefined && folderKey(f) === key) ??
    null
  );
}

/** The live file named `key` directly under `parentId` (root when undefined). */
export async function findChildFile(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
  parentId: FolderId | undefined,
  key: string,
): Promise<Doc<"files"> | null> {
  return await ctx.db
    .query("files")
    .withIndex("by_workspace_and_parent_and_name_key", (q) =>
      q.eq("workspaceId", workspaceId).eq("parentId", parentId).eq("nameKey", key),
    )
    .first();
}

/**
 * One namespace per folder: NAME_EXISTS when a file or folder other than
 * `self` already uses `key` under `parentId`. Reading these index ranges in
 * the writing mutation makes concurrent claims of one name conflict.
 */
export async function assertNameFree(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
  parentId: FolderId | undefined,
  key: string,
  self?: { fileId?: Id<"files">; folderId?: FolderId },
) {
  const file = await findChildFile(ctx, workspaceId, parentId, key);
  if (file && file._id !== self?.fileId)
    throw new ConvexError({
      code: "NAME_EXISTS",
      kind: "file",
      fileId: file._id,
      name: file.name,
      currentVersion: file.version,
    });
  const folder = await findChildFolder(ctx, workspaceId, parentId, key);
  if (folder && folder._id !== self?.folderId)
    throw new ConvexError({
      code: "NAME_EXISTS",
      kind: "folder",
      folderId: folder._id,
      name: folder.name,
    });
}

/**
 * Loads a folder by an untrusted id string. Missing, malformed, deleted and
 * other-tenant ids are all FOLDER_NOT_FOUND.
 */
export async function getFolderInWorkspace(
  ctx: ReadCtx,
  folderId: string,
  workspaceId: Id<"workspaces">,
): Promise<Doc<"folders">> {
  const id = ctx.db.normalizeId("folders", folderId);
  const folder = id ? await ctx.db.get(id) : null;
  if (!folder || folder.deletedAt !== undefined || folder.workspaceId !== workspaceId)
    throw new ConvexError({ code: "FOLDER_NOT_FOUND", folderId });
  return folder;
}

/** A destination parent: live and in the workspace, else INVALID_PARENT_FOLDER. */
export async function requireParentFolder(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
  parentId: FolderId | null | undefined,
): Promise<Doc<"folders"> | null> {
  if (!parentId) return null;
  const parent = await ctx.db.get(parentId);
  if (!parent || parent.deletedAt !== undefined || parent.workspaceId !== workspaceId)
    throw new ConvexError({ code: "INVALID_PARENT_FOLDER" });
  return parent;
}

/** `folder` and its ancestors, nearest first. */
async function ancestry(
  ctx: ReadCtx,
  folder: Doc<"folders">,
): Promise<Doc<"folders">[]> {
  const chain = [folder];
  let parentId = folder.parentId;
  // The depth limit keeps chains short; the bound also stops a corrupt cycle.
  while (parentId && chain.length <= MAX_FOLDER_DEPTH * 2) {
    const parent = await ctx.db.get(parentId);
    if (!parent) break;
    chain.push(parent);
    parentId = parent.parentId;
  }
  return chain;
}

export async function folderPath(
  ctx: ReadCtx,
  folderId?: FolderId | null,
): Promise<string> {
  if (!folderId) return "/";
  const folder = await ctx.db.get(folderId);
  if (!folder) return "/";
  return "/" + (await ancestry(ctx, folder)).reverse().map((f) => f.name).join("/");
}

export async function filePath(ctx: ReadCtx, file: Doc<"files">): Promise<string> {
  return joinPath(await folderPath(ctx, file.parentId), file.name);
}

/** Root-first `{ id, name }` crumbs for `folder` (root itself excluded). */
export async function breadcrumbs(
  ctx: ReadCtx,
  folder: Doc<"folders"> | null,
): Promise<{ id: FolderId; name: string }[]> {
  if (!folder) return [];
  return (await ancestry(ctx, folder))
    .reverse()
    .map((f) => ({ id: f._id, name: f.name }));
}

export type ResolvedPath =
  | { kind: "root" }
  | { kind: "folder"; folder: Doc<"folders"> }
  | { kind: "file"; file: Doc<"files"> };

/**
 * Resolves a workspace path segment by segment with the nameKey collision
 * rules (case-insensitive). The last segment matches a folder or a file;
 * null when nothing is there. Malformed paths throw INVALID_PATH.
 */
export async function resolvePath(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
  path: string,
): Promise<ResolvedPath | null> {
  const segments = splitPath(path);
  if (segments.length === 0) return { kind: "root" };
  let parentId: FolderId | undefined;
  for (const [index, segment] of segments.entries()) {
    const key = nameKey(segment);
    const folder = await findChildFolder(ctx, workspaceId, parentId, key);
    if (index === segments.length - 1) {
      if (folder) return { kind: "folder", folder };
      const file = await findChildFile(ctx, workspaceId, parentId, key);
      return file ? { kind: "file", file } : null;
    }
    if (!folder) return null;
    parentId = folder._id;
  }
  return null;
}

/** Live child folders of `parentId` (root when undefined). */
export async function listChildFolders(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
  parentId: FolderId | undefined,
  limit: number,
): Promise<Doc<"folders">[]> {
  return await ctx.db
    .query("folders")
    .withIndex("by_workspace_and_deleted_at_and_parent", (q) =>
      q.eq("workspaceId", workspaceId).eq("deletedAt", undefined).eq("parentId", parentId),
    )
    .take(limit);
}

/** Live files directly in `parentId` (root when undefined). */
export async function listChildFiles(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
  parentId: FolderId | undefined,
  limit: number,
): Promise<Doc<"files">[]> {
  return await ctx.db
    .query("files")
    .withIndex("by_workspace_and_deleted_at_and_parent", (q) =>
      q.eq("workspaceId", workspaceId).eq("deletedAt", undefined).eq("parentId", parentId),
    )
    .take(limit);
}

export type FolderIndex = Awaited<ReturnType<typeof loadFolderIndex>>;

/**
 * One read of the workspace's live folders (≤ MAX_INDEXED_FOLDERS) that
 * computes paths without per-row reads. Folders beyond the cap show as "…".
 */
export async function loadFolderIndex(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
) {
  const rows = await ctx.db
    .query("folders")
    .withIndex("by_workspace_and_deleted_at_and_parent", (q) =>
      q.eq("workspaceId", workspaceId).eq("deletedAt", undefined),
    )
    .take(MAX_INDEXED_FOLDERS + 1);
  const folders = rows.slice(0, MAX_INDEXED_FOLDERS);
  const byId = new Map(folders.map((f) => [f._id, f] as const));
  const paths = new Map<FolderId, string>();
  const pathOf = (id: FolderId | null | undefined, depth = 0): string => {
    if (!id) return "/";
    const cached = paths.get(id);
    if (cached !== undefined) return cached;
    const folder = byId.get(id);
    if (!folder || depth > MAX_FOLDER_DEPTH * 2) return "/…";
    const path = joinPath(pathOf(folder.parentId, depth + 1), folder.name);
    paths.set(id, path);
    return path;
  };
  return {
    folders,
    truncated: rows.length > MAX_INDEXED_FOLDERS,
    get: (id: FolderId) => byId.get(id),
    folderPath: (id?: FolderId | null) => pathOf(id),
    filePath: (file: Doc<"files">) => joinPath(pathOf(file.parentId), file.name),
  };
}

// ---------------------------------------------------------------------------
// Version checks and revision rows

export function checkFileVersion(file: Doc<"files">, expectedVersion: number) {
  if (file.deletedAt !== undefined)
    throw new ConvexError({ code: "FILE_NOT_FOUND" });
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
    throw new ConvexError({ code: "INVALID_INPUT" });
  if (file.version !== expectedVersion)
    throw new ConvexError({
      code: "VERSION_CONFLICT",
      currentVersion: file.version,
      expectedVersion,
    });
}

function checkFolderRevision(folder: Doc<"folders">, expectedRevision: number) {
  if (folder.deletedAt !== undefined)
    throw new ConvexError({ code: "FOLDER_NOT_FOUND", folderId: folder._id });
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
    throw new ConvexError({ code: "INVALID_INPUT" });
  if (folder.revision !== expectedRevision)
    throw new ConvexError({
      code: "VERSION_CONFLICT",
      folderId: folder._id,
      currentRevision: folder.revision,
      expectedRevision,
    });
}

/**
 * Revision row for a metadata-only change (rename, move): version `version`
 * carries the file's current content or blob unchanged.
 */
export async function insertMetadataRevision(
  ctx: MutationCtx,
  file: Doc<"files">,
  version: number,
  actor: Actor,
  now: number,
) {
  if (file.content === undefined && !file.storageId) return;
  const blob = file.storageId
    ? await ctx.db.system.get("_storage", file.storageId)
    : null;
  await ctx.db.insert("file_revisions", {
    workspaceId: file.workspaceId,
    fileId: file._id,
    version,
    content: file.content ?? "",
    ...(file.storageId
      ? { storageId: file.storageId, mimeType: file.mimeType, size: blob?.size }
      : {}),
    actor,
    createdAt: now,
  });
}

// ---------------------------------------------------------------------------
// Folder operations

/** Depth of a new child of `parent` (1 for a root child). */
async function childDepth(ctx: ReadCtx, parent: Doc<"folders"> | null) {
  return parent ? (await ancestry(ctx, parent)).length + 1 : 1;
}

export async function createFolderCore(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    parentId?: FolderId | null;
    name: string;
    actor: Actor;
  },
): Promise<Doc<"folders">> {
  const { workspaceId, actor } = args;
  const parent = await requireParentFolder(ctx, workspaceId, args.parentId);
  const parentId = parent?._id;
  const { name, key } = requireValidName(args.name);
  if ((await childDepth(ctx, parent)) > MAX_FOLDER_DEPTH)
    throw new ConvexError({ code: "FOLDER_TOO_DEEP", maxDepth: MAX_FOLDER_DEPTH });
  await assertNameFree(ctx, workspaceId, parentId, key);
  const now = Date.now();
  const folderId = await ctx.db.insert("folders", {
    workspaceId,
    parentId,
    name,
    nameKey: key,
    createdBy: actor,
    updatedBy: actor,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  await recordWorkspaceEvent(ctx, {
    workspaceId,
    kind: "folder.created",
    entityType: "folder",
    entityId: folderId,
    summary: `Created folder ${name}`,
    actor,
  });
  return (await ctx.db.get(folderId))!;
}

/**
 * `mkdir -p`: creates each missing folder along `path`. `created` is true
 * when the last segment was new. A segment naming a file is NAME_EXISTS.
 */
export async function ensureFolderPathCore(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; path: string; actor: Actor },
): Promise<{ folder: Doc<"folders">; created: boolean }> {
  const { workspaceId, actor } = args;
  const segments = splitPath(args.path);
  if (segments.length === 0)
    throw new ConvexError({ code: "INVALID_PATH", path: args.path });
  let folder: Doc<"folders"> | null = null;
  let created = false;
  for (const segment of segments) {
    const parentId: FolderId | undefined = folder?._id;
    const existing = await findChildFolder(ctx, workspaceId, parentId, nameKey(segment));
    if (existing) {
      folder = existing;
      created = false;
      continue;
    }
    // createFolderCore reports a file in the way as NAME_EXISTS (kind "file").
    folder = await createFolderCore(ctx, { workspaceId, parentId, name: segment, actor });
    created = true;
  }
  return { folder: folder!, created };
}

export async function renameFolderCore(
  ctx: MutationCtx,
  args: {
    folder: Doc<"folders">;
    name: string;
    expectedRevision: number;
    actor: Actor;
  },
): Promise<Doc<"folders">> {
  const { folder, actor } = args;
  checkFolderRevision(folder, args.expectedRevision);
  const { name, key } = requireValidName(args.name);
  await assertNameFree(ctx, folder.workspaceId, folder.parentId, key, {
    folderId: folder._id,
  });
  await ctx.db.patch(folder._id, {
    name,
    nameKey: key,
    revision: folder.revision + 1,
    updatedAt: Date.now(),
    updatedBy: actor,
  });
  await recordWorkspaceEvent(ctx, {
    workspaceId: folder.workspaceId,
    kind: "folder.renamed",
    entityType: "folder",
    entityId: folder._id,
    summary: `Renamed folder ${folder.name} to ${name}`,
    actor,
  });
  return (await ctx.db.get(folder._id))!;
}

/** Levels in the live subtree rooted at `folder` (1 for a leaf), up to `cap`. */
async function subtreeHeight(
  ctx: ReadCtx,
  folder: Doc<"folders">,
  cap: number,
): Promise<number> {
  let level = [folder._id];
  let height = 0;
  while (level.length > 0 && height <= cap) {
    height++;
    const next: FolderId[] = [];
    for (const id of level) {
      const children = await listChildFolders(ctx, folder.workspaceId, id, MAX_INDEXED_FOLDERS);
      next.push(...children.map((c) => c._id));
    }
    level = next;
  }
  return height;
}

export async function moveFolderCore(
  ctx: MutationCtx,
  args: {
    folder: Doc<"folders">;
    parentId: FolderId | null;
    expectedRevision: number;
    name?: string;
    actor: Actor;
  },
): Promise<Doc<"folders">> {
  const { folder, actor } = args;
  const { workspaceId } = folder;
  checkFolderRevision(folder, args.expectedRevision);
  const dest = await requireParentFolder(ctx, workspaceId, args.parentId);
  const destChain = dest ? await ancestry(ctx, dest) : [];
  if (destChain.some((f) => f._id === folder._id))
    throw new ConvexError({ code: "INVALID_MOVE", folderId: folder._id });
  const room = MAX_FOLDER_DEPTH - destChain.length;
  if ((await subtreeHeight(ctx, folder, room)) > room)
    throw new ConvexError({ code: "FOLDER_TOO_DEEP", maxDepth: MAX_FOLDER_DEPTH });
  const { name, key } =
    args.name !== undefined
      ? requireValidName(args.name)
      : { name: folder.name, key: folderKey(folder) };
  await assertNameFree(ctx, workspaceId, dest?._id, key, { folderId: folder._id });
  const destPath = await folderPath(ctx, dest?._id);
  await ctx.db.patch(folder._id, {
    parentId: dest?._id,
    name,
    nameKey: key,
    revision: folder.revision + 1,
    updatedAt: Date.now(),
    updatedBy: actor,
  });
  await recordWorkspaceEvent(ctx, {
    workspaceId,
    kind: "folder.moved",
    entityType: "folder",
    entityId: folder._id,
    summary:
      `Moved folder ${folder.name} to ${destPath}` +
      (name !== folder.name ? ` as ${name}` : ""),
    actor,
  });
  return (await ctx.db.get(folder._id))!;
}

/**
 * Soft-deletes `folder` and its live subtree (≤ MAX_DELETE_ITEMS folders and
 * files, else FOLDER_TOO_LARGE before any write). Every file gets a
 * `file.deleted` tombstone event; the folder gets one `folder.deleted`.
 * Deleted rows release their nameKey; content and revisions are kept.
 */
export async function deleteFolderCore(
  ctx: MutationCtx,
  args: { folder: Doc<"folders">; expectedRevision: number; actor: Actor },
): Promise<{ deletedFiles: number; deletedFolders: number }> {
  const { folder, actor } = args;
  const { workspaceId } = folder;
  checkFolderRevision(folder, args.expectedRevision);
  const folders = [folder];
  const files: Doc<"files">[] = [];
  const tooLarge = () =>
    new ConvexError({ code: "FOLDER_TOO_LARGE", limit: MAX_DELETE_ITEMS });
  for (let i = 0; i < folders.length; i++) {
    const room = () => MAX_DELETE_ITEMS - folders.length - files.length;
    files.push(...(await listChildFiles(ctx, workspaceId, folders[i]!._id, room() + 1)));
    if (room() < 0) throw tooLarge();
    folders.push(...(await listChildFolders(ctx, workspaceId, folders[i]!._id, room() + 1)));
    if (room() < 0) throw tooLarge();
  }
  const now = Date.now();
  for (const file of files) {
    await ctx.db.patch(file._id, {
      deletedAt: now,
      deletedBy: actor,
      nameKey: undefined,
      revision: file.revision + 1,
      updatedAt: now,
      updatedBy: actor,
    });
    // Sync tombstone, as deleteFileCore records for a single file.
    await recordWorkspaceEvent(ctx, {
      workspaceId,
      kind: "file.deleted",
      entityType: "file",
      entityId: file._id,
      summary: `Deleted ${file.name}`,
      actor,
    });
  }
  for (const row of folders)
    await ctx.db.patch(row._id, {
      deletedAt: now,
      deletedBy: actor,
      nameKey: undefined,
      revision: row.revision + 1,
      updatedAt: now,
      updatedBy: actor,
    });
  await recordWorkspaceEvent(ctx, {
    workspaceId,
    kind: "folder.deleted",
    entityType: "folder",
    entityId: folder._id,
    summary: `Deleted folder ${folder.name} (${files.length} files, ${folders.length} folders)`,
    actor,
  });
  return { deletedFiles: files.length, deletedFolders: folders.length };
}

// ---------------------------------------------------------------------------
// File moves

/**
 * Like renameFileCore: version N+1 with a revision row carrying the same
 * content, and a `file.moved` event. Destination collisions are NAME_EXISTS.
 */
export async function moveFileCore(
  ctx: MutationCtx,
  args: {
    file: Doc<"files">;
    parentId: FolderId | null;
    expectedVersion: number;
    name?: string;
    actor: Actor;
  },
): Promise<Doc<"files">> {
  const { file, actor } = args;
  checkFileVersion(file, args.expectedVersion);
  const dest = await requireParentFolder(ctx, file.workspaceId, args.parentId);
  const { name, key } =
    args.name !== undefined
      ? requireValidName(args.name)
      : { name: file.name, key: file.nameKey ?? nameKey(file.name) };
  await assertNameFree(ctx, file.workspaceId, dest?._id, key, { fileId: file._id });
  const destPath = await folderPath(ctx, dest?._id);
  const now = Date.now();
  const version = file.version + 1;
  await ctx.db.patch(file._id, {
    parentId: dest?._id,
    name,
    nameKey: key,
    version,
    revision: file.revision + 1,
    updatedAt: now,
    updatedBy: actor,
  });
  await insertMetadataRevision(ctx, file, version, actor, now);
  await recordWorkspaceEvent(ctx, {
    workspaceId: file.workspaceId,
    kind: "file.moved",
    entityType: "file",
    entityId: file._id,
    summary:
      `Moved ${file.name} to ${destPath}` +
      (name !== file.name ? ` as ${name}` : ""),
    actor,
  });
  return (await ctx.db.get(file._id))!;
}
