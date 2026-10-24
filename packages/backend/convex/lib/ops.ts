// Core workspace operations shared by the dashboard (Convex Auth) and agent
// (MCP token) entry points. Callers authorize first and pass a verified actor
// and workspace; nothing here reads identity from arguments.
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { type Actor, recordWorkspaceEvent } from "./auth";
import { MAX_NAME_LENGTH, nameKey, storedName } from "./names";

type ReadCtx = QueryCtx | MutationCtx;

export type ContextField = Doc<"context_proposals">["field"];

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

/**
 * Loads a file by an untrusted id string. Missing, malformed and other-tenant
 * ids are all FILE_NOT_FOUND so ids can't be probed.
 */
export async function getFileInWorkspace(
  ctx: ReadCtx,
  fileId: string,
  workspaceId: Id<"workspaces">,
): Promise<Doc<"files">> {
  const id = ctx.db.normalizeId("files", fileId);
  const file = id ? await ctx.db.get(id) : null;
  if (!file || file.workspaceId !== workspaceId)
    throw new ConvexError({ code: "FILE_NOT_FOUND", fileId });
  return file;
}

/** Deduplicated file ids, each in `workspaceId`; otherwise INVALID_SOURCE_FILE. */
export async function checkSourceFiles(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
  fileIds: string[],
): Promise<Id<"files">[]> {
  const unique = [...new Set(fileIds)];
  if (unique.length > 20) throw new ConvexError({ code: "INVALID_INPUT" });
  const result: Id<"files">[] = [];
  for (const raw of unique) {
    const id = ctx.db.normalizeId("files", raw);
    const file = id ? await ctx.db.get(id) : null;
    if (!file || file.workspaceId !== workspaceId)
      throw new ConvexError({ code: "INVALID_SOURCE_FILE", fileId: raw });
    result.push(file._id);
  }
  return result;
}

export async function createDocumentCore(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    parentId?: Id<"folders">;
    name: string;
    mimeType: string;
    content: string;
    actor: Actor;
  },
): Promise<Doc<"files">> {
  const { workspaceId, parentId, actor } = args;
  if (parentId) {
    const folder = await ctx.db.get(parentId);
    if (!folder || folder.workspaceId !== workspaceId)
      throw new ConvexError({ code: "INVALID_PARENT_FOLDER" });
  }
  const name = storedName(args.name);
  const key = nameKey(name);
  if (!key || name.length > MAX_NAME_LENGTH)
    throw new ConvexError({ code: "INVALID_NAME" });
  // Convex has no unique indexes: reading this index range in the same
  // mutation as the insert makes concurrent creates of one name conflict.
  const existing = await ctx.db
    .query("files")
    .withIndex("by_workspace_and_parent_and_name_key", (q) =>
      q
        .eq("workspaceId", workspaceId)
        .eq("parentId", parentId)
        .eq("nameKey", key),
    )
    .first();
  if (existing)
    throw new ConvexError({
      code: "NAME_EXISTS",
      fileId: existing._id,
      name: existing.name,
      currentVersion: existing.version,
    });
  const now = Date.now();
  const fileId = await ctx.db.insert("files", {
    workspaceId,
    parentId,
    name,
    nameKey: key,
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
    summary: `Created ${name}`,
    actor,
  });
  const file = await ctx.db.get(fileId);
  if (!file) throw new ConvexError({ code: "FILE_NOT_FOUND" });
  return file;
}

/**
 * Writes version N+1 only when expectedVersion is exactly N. Any other
 * positive integer (older or newer) is VERSION_CONFLICT with both versions.
 */
export async function updateDocumentCore(
  ctx: MutationCtx,
  args: {
    file: Doc<"files">;
    content: string;
    expectedVersion: number;
    actor: Actor;
  },
): Promise<Doc<"files">> {
  const { file, actor, expectedVersion } = args;
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
    throw new ConvexError({
      code: "INVALID_INPUT",
      fileId: file._id,
      expectedVersion,
    });
  if (file.version !== expectedVersion) {
    throw new ConvexError({
      code: "VERSION_CONFLICT",
      fileId: file._id,
      currentVersion: file.version,
      expectedVersion,
      currentContent: file.content ?? null,
      updatedBy: file.updatedBy,
    });
  }
  const now = Date.now();
  const version = file.version + 1;
  await ctx.db.patch(file._id, {
    content: args.content,
    version,
    updatedBy: actor,
    revision: file.revision + 1,
    updatedAt: now,
    // Backfill the collision key on files created before it existed.
    ...(file.nameKey === undefined ? { nameKey: nameKey(file.name) } : {}),
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
  if (!updated) throw new ConvexError({ code: "FILE_NOT_FOUND" });
  return updated;
}

export function toFolderMetadata(folder: Doc<"folders">) {
  return {
    id: folder._id,
    workspaceId: folder.workspaceId,
    parentId: folder.parentId ?? null,
    name: folder.name,
    revision: folder.revision,
    updatedAt: folder.updatedAt,
    updatedBy: folder.updatedBy,
  };
}

/** The folder in `workspaceId` with this id; otherwise INVALID_PARENT_FOLDER. */
async function requireParentFolder(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
  parentId: Id<"folders">,
): Promise<Doc<"folders">> {
  const folder = await ctx.db.get(parentId);
  if (!folder || folder.workspaceId !== workspaceId)
    throw new ConvexError({ code: "INVALID_PARENT_FOLDER" });
  return folder;
}

const LEGACY_FOLDER_SCAN_LIMIT = 200;

/**
 * A folder under `parentId` whose collision key is `key`, other than
 * `excludeId`. Reading the index range makes concurrent writes of one name
 * conflict. Folders from before nameKey existed are matched by computing
 * their key.
 */
async function findSiblingFolder(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
  parentId: Id<"folders"> | undefined,
  key: string,
  excludeId?: Id<"folders">,
): Promise<Doc<"folders"> | undefined> {
  const withKey = (candidate: string | undefined) =>
    ctx.db
      .query("folders")
      .withIndex("by_workspace_and_parent_and_name_key", (q) =>
        q
          .eq("workspaceId", workspaceId)
          .eq("parentId", parentId)
          .eq("nameKey", candidate),
      );
  const keyed = await withKey(key).take(2);
  const legacy = await withKey(undefined).take(LEGACY_FOLDER_SCAN_LIMIT);
  return (
    keyed.find((folder) => folder._id !== excludeId) ??
    legacy.find(
      (folder) => folder._id !== excludeId && nameKey(folder.name) === key,
    )
  );
}

export async function createFolderCore(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    parentId?: Id<"folders">;
    name: string;
    actor: Actor;
  },
): Promise<Doc<"folders">> {
  const { workspaceId, parentId, actor } = args;
  if (parentId) await requireParentFolder(ctx, workspaceId, parentId);
  const name = storedName(args.name);
  const key = nameKey(name);
  if (!key || name.length > MAX_NAME_LENGTH)
    throw new ConvexError({ code: "INVALID_NAME" });
  const existing = await findSiblingFolder(ctx, workspaceId, parentId, key);
  if (existing)
    throw new ConvexError({
      code: "NAME_EXISTS",
      folderId: existing._id,
      name: existing.name,
    });
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
  const folder = await ctx.db.get(folderId);
  if (!folder) throw new ConvexError({ code: "FOLDER_NOT_FOUND" });
  return folder;
}

/** Deepest folder chain walked for cycle checks and paths. */
export const MAX_FOLDER_DEPTH = 64;

/** Exactly the folder's current revision; INVALID_INPUT or VERSION_CONFLICT otherwise. */
function checkFolderRevision(folder: Doc<"folders">, expectedRevision: number) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
    throw new ConvexError({
      code: "INVALID_INPUT",
      folderId: folder._id,
      expectedRevision,
    });
  if (folder.revision !== expectedRevision)
    throw new ConvexError({
      code: "VERSION_CONFLICT",
      folderId: folder._id,
      currentRevision: folder.revision,
      expectedRevision,
    });
}

/**
 * Renames a folder within its parent. A rename that keeps the collision key
 * (case or whitespace only) is allowed; an identical name writes nothing.
 */
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
  const name = storedName(args.name);
  const key = nameKey(name);
  if (!key || name.length > MAX_NAME_LENGTH)
    throw new ConvexError({ code: "INVALID_NAME" });
  if (name === folder.name) return folder;
  const existing = await findSiblingFolder(
    ctx,
    folder.workspaceId,
    folder.parentId,
    key,
    folder._id,
  );
  if (existing)
    throw new ConvexError({
      code: "NAME_EXISTS",
      folderId: existing._id,
      name: existing.name,
    });
  await ctx.db.patch(folder._id, {
    name,
    nameKey: key,
    updatedBy: actor,
    revision: folder.revision + 1,
    updatedAt: Date.now(),
  });
  await recordWorkspaceEvent(ctx, {
    workspaceId: folder.workspaceId,
    kind: "folder.renamed",
    entityType: "folder",
    entityId: folder._id,
    summary: `Renamed folder ${folder.name} to ${name}`,
    actor,
  });
  const renamed = await ctx.db.get(folder._id);
  if (!renamed) throw new ConvexError({ code: "FOLDER_NOT_FOUND" });
  return renamed;
}

/**
 * Moves a folder (and so its subtree) under `parentId`, or to the top level
 * for null. The destination may not be the folder itself or a descendant.
 */
export async function moveFolderCore(
  ctx: MutationCtx,
  args: {
    folder: Doc<"folders">;
    parentId: Id<"folders"> | null;
    expectedRevision: number;
    actor: Actor;
  },
): Promise<Doc<"folders">> {
  const { folder, parentId, actor } = args;
  checkFolderRevision(folder, args.expectedRevision);
  const destination = parentId
    ? await requireParentFolder(ctx, folder.workspaceId, parentId)
    : null;
  if ((folder.parentId ?? null) === parentId) return folder;
  // Walk up from the destination: reaching the folder means a cycle.
  let ancestor = destination;
  for (let depth = 0; ancestor; depth++) {
    if (ancestor._id === folder._id)
      throw new ConvexError({ code: "FOLDER_CYCLE", folderId: folder._id });
    if (depth >= MAX_FOLDER_DEPTH)
      throw new ConvexError({
        code: "INVALID_INPUT",
        folderId: folder._id,
        field: "parentId",
      });
    const next: Doc<"folders"> | null = ancestor.parentId
      ? await ctx.db.get(ancestor.parentId)
      : null;
    ancestor = next && next.workspaceId === folder.workspaceId ? next : null;
  }
  const key = folder.nameKey ?? nameKey(folder.name);
  const existing = await findSiblingFolder(
    ctx,
    folder.workspaceId,
    parentId ?? undefined,
    key,
    folder._id,
  );
  if (existing)
    throw new ConvexError({
      code: "NAME_EXISTS",
      folderId: existing._id,
      name: existing.name,
    });
  await ctx.db.patch(folder._id, {
    parentId: parentId ?? undefined,
    nameKey: key,
    updatedBy: actor,
    revision: folder.revision + 1,
    updatedAt: Date.now(),
  });
  await recordWorkspaceEvent(ctx, {
    workspaceId: folder.workspaceId,
    kind: "folder.moved",
    entityType: "folder",
    entityId: folder._id,
    summary: destination
      ? `Moved folder ${folder.name} to ${destination.name}`
      : `Moved folder ${folder.name} to the top level`,
    actor,
  });
  const moved = await ctx.db.get(folder._id);
  if (!moved) throw new ConvexError({ code: "FOLDER_NOT_FOUND" });
  return moved;
}

/**
 * A resolver from a file's parentId to its folder path ("specs/api/"; "" at
 * the top level). Shares a cache across calls, stays inside `workspaceId`, and
 * stops after MAX_FOLDER_DEPTH folders.
 */
export function folderPaths(ctx: ReadCtx, workspaceId: Id<"workspaces">) {
  const cache = new Map<Id<"folders">, string>();
  return async (folderId: Id<"folders"> | null | undefined): Promise<string> => {
    const chain: Doc<"folders">[] = [];
    let prefix = "";
    for (let id = folderId ?? undefined; id; ) {
      const cached = cache.get(id);
      if (cached !== undefined) {
        prefix = cached;
        break;
      }
      if (chain.length >= MAX_FOLDER_DEPTH) break;
      const folder: Doc<"folders"> | null = await ctx.db.get(id);
      if (!folder || folder.workspaceId !== workspaceId) break;
      chain.push(folder);
      id = folder.parentId;
    }
    for (const folder of chain.reverse()) {
      prefix = `${prefix}${folder.name}/`;
      cache.set(folder._id, prefix);
    }
    return prefix;
  };
}

export const FOLDER_LIST_LIMIT = 500;

/** Every folder in the workspace (flat; rebuild the tree from parentId), up to FOLDER_LIST_LIMIT. */
export async function listFoldersCore(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
) {
  const rows = await ctx.db
    .query("folders")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .take(FOLDER_LIST_LIMIT + 1);
  return {
    folders: rows.slice(0, FOLDER_LIST_LIMIT).map(toFolderMetadata),
    truncated: rows.length > FOLDER_LIST_LIMIT,
  };
}

/** Exactly the file's current version; INVALID_INPUT or VERSION_CONFLICT otherwise. */
export function checkFileVersion(file: Doc<"files">, expectedVersion: number) {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
    throw new ConvexError({
      code: "INVALID_INPUT",
      fileId: file._id,
      expectedVersion,
    });
  if (file.version !== expectedVersion) {
    throw new ConvexError({
      code: "VERSION_CONFLICT",
      fileId: file._id,
      currentVersion: file.version,
      expectedVersion,
      currentContent: file.content ?? null,
      updatedBy: file.updatedBy,
    });
  }
}

/**
 * Moves a file to `parentId` (null for the top level). A move is metadata: it
 * bumps `revision` but not `version` and writes no file_revisions row, though
 * it still needs the current `expectedVersion` so a stale client can't move.
 */
export async function moveFileCore(
  ctx: MutationCtx,
  args: {
    file: Doc<"files">;
    parentId: Id<"folders"> | null;
    expectedVersion: number;
    actor: Actor;
  },
): Promise<Doc<"files">> {
  const { file, parentId, actor } = args;
  checkFileVersion(file, args.expectedVersion);
  const folder = parentId
    ? await requireParentFolder(ctx, file.workspaceId, parentId)
    : null;
  if ((file.parentId ?? null) === parentId) return file;
  const key = file.nameKey ?? nameKey(file.name);
  const existing = await ctx.db
    .query("files")
    .withIndex("by_workspace_and_parent_and_name_key", (q) =>
      q
        .eq("workspaceId", file.workspaceId)
        .eq("parentId", parentId ?? undefined)
        .eq("nameKey", key),
    )
    .first();
  if (existing)
    throw new ConvexError({
      code: "NAME_EXISTS",
      fileId: existing._id,
      name: existing.name,
      currentVersion: existing.version,
    });
  await ctx.db.patch(file._id, {
    parentId: parentId ?? undefined,
    nameKey: key,
    updatedBy: actor,
    revision: file.revision + 1,
    updatedAt: Date.now(),
  });
  await recordWorkspaceEvent(ctx, {
    workspaceId: file.workspaceId,
    kind: "file.moved",
    entityType: "file",
    entityId: file._id,
    summary: folder
      ? `Moved ${file.name} to ${folder.name}`
      : `Moved ${file.name} to the top level`,
    actor,
  });
  const moved = await ctx.db.get(file._id);
  if (!moved) throw new ConvexError({ code: "FILE_NOT_FOUND" });
  return moved;
}

const MAX_OWNER_AREA_LENGTH = 200;

/**
 * The proposed owner in an ownership change: a current member of
 * `workspaceId`. Malformed, unknown and other-tenant ids are all INVALID_INPUT.
 */
export async function requireOwnerMember(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
  ownerUserId: string,
): Promise<Doc<"users">> {
  const userId = ctx.db.normalizeId("users", ownerUserId);
  const membership = userId
    ? await ctx.db
        .query("workspace_members")
        .withIndex("by_workspace_and_user", (q) =>
          q.eq("workspaceId", workspaceId).eq("userId", userId),
        )
        .unique()
    : null;
  const user = membership ? await ctx.db.get(membership.userId) : null;
  if (!user)
    throw new ConvexError({
      code: "INVALID_INPUT",
      field: "ownerUserId",
      message: "The proposed owner must be a current member of this workspace.",
    });
  return user;
}

/** Display form of an ownership entry; the structured owner is stored alongside. */
export function ownershipText(area: string, owner: Doc<"users">): string {
  return `${area}: ${owner.name ?? owner.email ?? "Workspace member"}`;
}

export async function proposeContextChangeCore(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    field: ContextField;
    /** For ownership, the area being assigned. */
    proposedValue: string;
    rationale: string;
    sourceFileIds: Id<"files">[];
    /** Untrusted; required for ownership and rejected for every other field. */
    ownerUserId?: string;
    actor: Actor;
  },
): Promise<Doc<"context_proposals">> {
  const { workspaceId, actor, field } = args;
  let proposedValue = args.proposedValue;
  let owner: { ownerUserId: Id<"users">; ownerArea: string } | undefined;
  if (field === "ownership") {
    const area = args.proposedValue.trim();
    if (!area || area.length > MAX_OWNER_AREA_LENGTH)
      throw new ConvexError({ code: "INVALID_INPUT", field: "proposedValue" });
    if (args.ownerUserId === undefined)
      throw new ConvexError({ code: "INVALID_INPUT", field: "ownerUserId" });
    const user = await requireOwnerMember(ctx, workspaceId, args.ownerUserId);
    owner = { ownerUserId: user._id, ownerArea: area };
    proposedValue = ownershipText(area, user);
  } else if (args.ownerUserId !== undefined) {
    throw new ConvexError({ code: "INVALID_INPUT", field: "ownerUserId" });
  }
  const context = await ctx.db
    .query("structured_context")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  if (!context) throw new ConvexError({ code: "CONTEXT_NOT_INITIALIZED" });
  const currentField =
    field === "goal"
      ? (context.goal?.text ?? null)
      : field === "scope"
        ? (context.scope?.text ?? null)
        : undefined;
  const now = Date.now();
  const proposalId = await ctx.db.insert("context_proposals", {
    workspaceId,
    field,
    proposedValue,
    rationale: args.rationale,
    sourceFileIds: args.sourceFileIds,
    contextRevision: context.revision,
    ...(currentField !== undefined ? { baseValue: currentField } : {}),
    ...owner,
    status: "pending",
    createdBy: actor,
    createdAt: now,
    updatedBy: actor,
    updatedAt: now,
    revision: 1,
  });
  await recordWorkspaceEvent(ctx, {
    workspaceId,
    kind: "context.proposed",
    entityType: "context_proposal",
    entityId: proposalId,
    summary: `Proposed a change to ${field.replaceAll("_", " ")}`,
    actor,
  });
  const proposal = await ctx.db.get(proposalId);
  if (!proposal) throw new ConvexError({ code: "PROPOSAL_NOT_FOUND" });
  return proposal;
}

export function toProposal(proposal: Doc<"context_proposals">) {
  return {
    id: proposal._id,
    workspaceId: proposal.workspaceId,
    field: proposal.field,
    proposedValue: proposal.proposedValue,
    rationale: proposal.rationale,
    sourceFileIds: proposal.sourceFileIds,
    status: proposal.status,
    createdBy: proposal.createdBy,
    createdAt: proposal.createdAt,
    decidedBy: proposal.decidedBy ?? null,
    decidedAt: proposal.decidedAt ?? null,
    ownerUserId: proposal.ownerUserId ?? null,
    ownerArea: proposal.ownerArea ?? null,
  };
}

export async function listProposals(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
  status: Doc<"context_proposals">["status"] | undefined,
  limit: number,
): Promise<Doc<"context_proposals">[]> {
  return status
    ? await ctx.db
        .query("context_proposals")
        .withIndex("by_workspace_and_status", (q) =>
          q.eq("workspaceId", workspaceId).eq("status", status),
        )
        .order("desc")
        .take(limit)
    : await ctx.db
        .query("context_proposals")
        .withIndex("by_workspace_and_created", (q) =>
          q.eq("workspaceId", workspaceId),
        )
        .order("desc")
        .take(limit);
}

export async function publishWorkCore(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    kind: Doc<"published_work">["kind"];
    title: string;
    summary: string;
    fileIds: Id<"files">[];
    actor: Actor;
  },
): Promise<Doc<"published_work">> {
  const title = args.title.trim();
  const summary = args.summary.trim();
  if (!title || title.length > 200 || !summary || summary.length > 4000)
    throw new ConvexError({ code: "INVALID_INPUT" });
  const now = Date.now();
  const workId = await ctx.db.insert("published_work", {
    workspaceId: args.workspaceId,
    kind: args.kind,
    title,
    summary,
    fileIds: args.fileIds,
    createdBy: args.actor,
    createdAt: now,
    updatedBy: args.actor,
    revision: 1,
    updatedAt: now,
  });
  await recordWorkspaceEvent(ctx, {
    workspaceId: args.workspaceId,
    kind: "work.published",
    entityType: "published_work",
    entityId: workId,
    summary: `Published ${args.kind}: ${truncate(title, 80)}`,
    actor: args.actor,
  });
  const work = await ctx.db.get(workId);
  if (!work) throw new ConvexError({ code: "INVALID_INPUT" });
  return work;
}

export function toPublishedWork(work: Doc<"published_work">) {
  return {
    id: work._id,
    workspaceId: work.workspaceId,
    kind: work.kind,
    title: work.title,
    summary: work.summary,
    fileIds: work.fileIds,
    createdBy: work.createdBy,
    createdAt: work.createdAt,
  };
}

/** Approved context in the same compact shape as workspaces:getWorkspaceContext. */
export async function loadContext(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
) {
  const context = await ctx.db
    .query("structured_context")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  if (!context) throw new ConvexError({ code: "CONTEXT_NOT_INITIALIZED" });
  type ContextEntry = NonNullable<Doc<"structured_context">["goal"]>;
  const compact = ({ text, sourceFileIds, updatedAt, updatedBy }: ContextEntry) => ({
    text,
    sourceFileIds,
    updatedAt,
    updatedBy,
  });
  return {
    goal: context.goal ? compact(context.goal) : null,
    scope: context.scope ? compact(context.scope) : null,
    constraints: context.constraints.map(compact),
    decisions: context.decisions.map(compact),
    ownership: context.ownership.map((entry) => ({
      ...compact(entry),
      ownerUserId: entry.ownerUserId ?? null,
      ownerArea: entry.ownerArea ?? null,
    })),
    openQuestions: context.openQuestions.map(compact),
    revision: context.revision,
    updatedAt: context.updatedAt,
    updatedBy: context.updatedBy,
  };
}

const SEARCH_SCAN_LIMIT = 200;
const SNIPPET_CHARS = 160;

/**
 * Case-insensitive substring match on name and current content. Scans the
 * newest SEARCH_SCAN_LIMIT files by updatedAt plus filename search-index hits,
 * so very old files are found by name but not by content.
 */
export async function searchFilesCore(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
  query: string,
  limit: number,
) {
  const needle = query.trim().toLowerCase();
  if (!needle || !Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new ConvexError({ code: "INVALID_INPUT" });
  const recent = await ctx.db
    .query("files")
    .withIndex("by_workspace_and_updated_at", (q) =>
      q.eq("workspaceId", workspaceId),
    )
    .order("desc")
    .take(SEARCH_SCAN_LIMIT);
  const byName = await ctx.db
    .query("files")
    .withSearchIndex("search_name", (q) =>
      q.search("name", query.trim()).eq("workspaceId", workspaceId),
    )
    .take(limit);
  const seen = new Set<Id<"files">>();
  const results: {
    file: ReturnType<typeof toFileMetadata>;
    snippet: string;
    match: "name" | "content";
  }[] = [];
  for (const file of [...recent, ...byName]) {
    if (seen.has(file._id)) continue;
    seen.add(file._id);
    const content = file.content ?? "";
    const nameMatch = file.name.toLowerCase().includes(needle);
    const at = content.toLowerCase().indexOf(needle);
    if (!nameMatch && at === -1) continue;
    results.push({
      file: toFileMetadata(file),
      snippet: at === -1 ? snippet(content, 0, 0) : snippet(content, at, needle.length),
      match: nameMatch ? "name" : "content",
    });
  }
  return results
    .sort(
      (a, b) =>
        Number(b.match === "name") - Number(a.match === "name") ||
        b.file.updatedAt - a.file.updatedAt,
    )
    .slice(0, limit);
}

/** ~SNIPPET_CHARS of `content` centred on [at, at+length), whitespace collapsed. */
function snippet(content: string, at: number, length: number): string {
  const lead = Math.max(0, Math.floor((SNIPPET_CHARS - length) / 2));
  const start = Math.max(0, Math.min(at - lead, content.length - SNIPPET_CHARS));
  const end = start + SNIPPET_CHARS;
  const text = content.slice(start, end).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + text + (end < content.length ? "…" : "");
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export const SYNC_LIMIT = 50;

export function toEvent(event: Doc<"workspace_events">) {
  return {
    id: event._id,
    seq: event.seq ?? 0,
    kind: event.kind,
    entityType: event.entityType,
    entityId: event.entityId,
    summary: event.summary,
    actor: event.actor,
    createdAt: event.createdAt,
  };
}

/**
 * Snapshot (sinceSeq undefined): latest SYNC_LIMIT events and newest files.
 * Incremental: events with seq > sinceSeq, oldest first, and the files they
 * touched. A sinceSeq past the newest event is INVALID_CURSOR.
 */
export async function syncCore(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
  sinceSeq: number | undefined,
) {
  const workspace = await ctx.db.get(workspaceId);
  if (!workspace) throw new ConvexError({ code: "WORKSPACE_NOT_FOUND" });
  const newest = await ctx.db
    .query("workspace_events")
    .withIndex("by_workspace_and_seq", (q) => q.eq("workspaceId", workspaceId))
    .order("desc")
    .first();
  const headSeq = newest?.seq ?? 0;
  let events: Doc<"workspace_events">[];
  let eventsTruncated: boolean;
  let changedFiles: Doc<"files">[];
  let filesTruncated: boolean;
  let cursorSeq: number;
  if (sinceSeq === undefined) {
    const latest = await ctx.db
      .query("workspace_events")
      .withIndex("by_workspace_and_seq", (q) =>
        q.eq("workspaceId", workspaceId).gt("seq", 0),
      )
      .order("desc")
      .take(SYNC_LIMIT + 1);
    eventsTruncated = latest.length > SYNC_LIMIT;
    events = latest.slice(0, SYNC_LIMIT).reverse();
    const files = await ctx.db
      .query("files")
      .withIndex("by_workspace_and_updated_at", (q) =>
        q.eq("workspaceId", workspaceId),
      )
      .order("desc")
      .take(SYNC_LIMIT + 1);
    filesTruncated = files.length > SYNC_LIMIT;
    changedFiles = files.slice(0, SYNC_LIMIT);
    cursorSeq = headSeq;
  } else {
    if (!Number.isSafeInteger(sinceSeq) || sinceSeq < 0 || sinceSeq > headSeq)
      throw new ConvexError({ code: "INVALID_CURSOR" });
    const after = await ctx.db
      .query("workspace_events")
      .withIndex("by_workspace_and_seq", (q) =>
        q.eq("workspaceId", workspaceId).gt("seq", sinceSeq),
      )
      .order("asc")
      .take(SYNC_LIMIT + 1);
    eventsTruncated = after.length > SYNC_LIMIT;
    events = after.slice(0, SYNC_LIMIT);
    cursorSeq = events.at(-1)?.seq ?? sinceSeq;
    const fileIds = new Set<string>();
    for (const event of events)
      if (event.entityType === "file") fileIds.add(event.entityId);
    changedFiles = [];
    for (const raw of fileIds) {
      const id = ctx.db.normalizeId("files", raw);
      const file = id ? await ctx.db.get(id) : null;
      if (file && file.workspaceId === workspaceId) changedFiles.push(file);
    }
    changedFiles.sort((a, b) => b.updatedAt - a.updatedAt);
    filesTruncated = false;
  }
  const pending = await listProposals(ctx, workspaceId, "pending", SYNC_LIMIT);
  return {
    workspace: { id: workspace._id, name: workspace.name },
    context: await loadContext(ctx, workspaceId),
    pendingProposals: pending.map((p) => ({
      id: p._id,
      field: p.field,
      rationale: p.rationale,
      createdBy: p.createdBy,
      createdAt: p.createdAt,
    })),
    changedFiles: changedFiles.map(toFileMetadata),
    filesTruncated,
    events: events.map(toEvent),
    eventsTruncated,
    headSeq,
    cursorSeq,
  };
}
