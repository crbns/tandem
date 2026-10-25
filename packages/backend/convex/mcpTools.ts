// What the MCP tools in convex/mcp.ts run: one internal mutation per tool
// call, so each tool's checks and writes are a single transaction. Every
// function takes the principal the @convex-dev/mcp component verified
// (lib/agent.ts requireAgent) and then runs the same core operations as the
// dashboard (lib/ops.ts) with agent attribution. They are internal, so only
// the MCP endpoint can call them, and mutations even for reads, because every
// agent call records lastMcpActionAt. There is deliberately no way to decide
// a proposal or change the approved context from here.
import { lineChanges } from "./lib/diff";
import { vMcpUser } from "@convex-dev/mcp";
import { ConvexError, v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  CONFLICT_CODES,
  currentContextRevision,
  recordActivity,
  requireAgent,
  requireWriteScope,
  resolveAgentWorkspace,
  touchConnection as recordAgentAction,
  type ActivityResource,
  type AgentSession,
  type McpPrincipal,
} from "./lib/agent";
import {
  checkSourceFiles,
  claimTaskCore,
  completeTaskCore,
  createDocumentCore,
  createTaskCore,
  getFileInWorkspace,
  getTaskInWorkspace,
  listProposals,
  listTasks,
  proposeContextChangeCore,
  publishWorkCore,
  searchFilesCore,
  syncCore,
  toPublishedWork,
  toProposal,
  toTask,
  updateDocumentCore,
  updateTaskCore,
} from "./lib/ops";
import {
  ensureFolderPathCore,
  fileRowValidator,
  filePath,
  folderPath,
  folderRowValidator,
  getFolderInWorkspace,
  joinPath,
  listChildFiles,
  listChildFolders,
  loadFolderIndex,
  MAX_FOLDER_DEPTH,
  moveFileCore,
  moveFolderCore,
  resolvePath,
  toFileRow,
  toFolderRow,
  type FolderIndex,
} from "./lib/fs";
import { matchesQuery, queryTerms } from "./lib/names";
import {
  actorValidator,
  contextApprovalValidator,
  contextFieldValidator,
  contextValidator,
  eventValidator,
  proposalStatusValidator,
  proposalValidator,
  publishedWorkValidator,
  roleValidator,
  taskStatusValidator,
  taskValidator,
} from "./lib/validators";

const LIST_LIMIT = 500;
// Live files a list_files query scans in the folder's subtree.
const LIST_SEARCH_SCAN = 1000;
const SYNC_FOLDER_LIMIT = 200;
const MEMBER_LIMIT = 100;
const TEXT_MIME_TYPES = new Set(["text/markdown", "text/plain"]);

const principal = vMcpUser();

async function agentCall(
  ctx: MutationCtx,
  user: McpPrincipal,
  options: { sync?: boolean; write?: boolean } = {},
): Promise<AgentSession> {
  const session = await requireAgent(ctx, user);
  if (options.write) requireWriteScope(session);
  await recordAgentAction(ctx, session, options);
  return session;
}

function boundedInt(value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new ConvexError({ code: "INVALID_INPUT" });
  return value;
}

function boundedText(value: string, max: number, field: string): string {
  const text = value.trim();
  if (!text || text.length > max)
    throw new ConvexError({ code: "INVALID_INPUT", field });
  return text;
}

/**
 * A folder named by id or by path (list_files, create_document and move
 * destinations); null is the root. A path that is missing or names a file is
 * PATH_NOT_FOUND; an id that isn't a live folder here is FOLDER_NOT_FOUND.
 */
async function folderArg(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  arg: { id?: string; path?: string },
  field: string,
): Promise<Doc<"folders"> | null> {
  if (arg.id !== undefined && arg.path !== undefined)
    throw new ConvexError({ code: "INVALID_INPUT", field });
  if (arg.id !== undefined) return await getFolderInWorkspace(ctx, arg.id, workspaceId);
  if (arg.path === undefined) return null;
  const found = await resolvePath(ctx, workspaceId, arg.path);
  if (found?.kind === "root") return null;
  if (found?.kind === "folder") return found.folder;
  throw new ConvexError({
    code: "PATH_NOT_FOUND",
    path: arg.path,
    expected: "folder",
    ...(found ? { found: "file" } : {}),
  });
}

/** True when `parentId` is `rootId` or below it; everything is below the root. */
function isWithin(
  index: FolderIndex,
  parentId: Id<"folders"> | undefined,
  rootId: Id<"folders"> | null,
): boolean {
  if (!rootId) return true;
  // The bound also stops a corrupt cycle.
  for (let at = parentId, hops = 0; at && hops <= 2 * MAX_FOLDER_DEPTH; hops++) {
    if (at === rootId) return true;
    at = index.get(at)?.parentId;
  }
  return false;
}

/** File metadata from lib/ops plus its path, computed from the folder index. */
function withPath<F extends { parentId: Id<"folders"> | null; name: string }>(
  index: FolderIndex,
  file: F,
): F & { path: string } {
  return { ...file, path: joinPath(index.folderPath(file.parentId), file.name) };
}

const byName = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

const fileResource = (file: { id: string; path: string }): ActivityResource => ({
  type: "file",
  id: file.id,
  label: file.path,
});

/** A failed call's resource label, looked up only inside the connection's workspace. */
async function failedResourceLabel(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  resource: ActivityResource,
): Promise<string | undefined> {
  if (resource.type === "file") {
    const id = ctx.db.normalizeId("files", resource.id);
    const file = id ? await ctx.db.get(id) : null;
    if (file?.workspaceId === workspaceId && file.deletedAt === undefined)
      return await filePath(ctx, file);
  } else if (resource.type === "folder") {
    const id = ctx.db.normalizeId("folders", resource.id);
    const folder = id ? await ctx.db.get(id) : null;
    if (folder?.workspaceId === workspaceId && folder.deletedAt === undefined)
      return await folderPath(ctx, folder._id);
  } else if (resource.type === "task") {
    const id = ctx.db.normalizeId("tasks", resource.id);
    const task = id ? await ctx.db.get(id) : null;
    if (task?.workspaceId === workspaceId) return task.title;
  }
  return undefined;
}

/**
 * Presence for a failed agent call. A failing tool mutation rolls back its own
 * touch, so the MCP endpoint calls this after a call fails (never after one
 * succeeds) to keep "last MCP action" honest. Records no sync. With `tool`, it
 * also records the failure as a conflict or error activity row.
 */
export const touchConnection = internalMutation({
  args: {
    principal,
    tool: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    resource: v.optional(
      v.object({
        type: v.union(v.literal("file"), v.literal("folder"), v.literal("task")),
        id: v.string(),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await agentCall(ctx, args.principal);
    if (args.tool === undefined) return null;
    const code = args.errorCode ?? "ERROR";
    const conflict = CONFLICT_CODES.has(code);
    let resource: ActivityResource | undefined;
    if (args.resource) {
      const label = await failedResourceLabel(ctx, session.workspaceId, args.resource);
      resource = { ...args.resource, ...(label !== undefined ? { label } : {}) };
    }
    const target = resource?.label ?? (resource ? `a ${resource.type}` : null);
    await recordActivity(ctx, session, {
      tool: args.tool,
      kind: conflict ? "conflict" : "error",
      outcome: conflict ? "conflict" : "error",
      errorCode: code,
      summary:
        code === "VERSION_CONFLICT"
          ? `Version conflict${target ? ` on ${target}` : ""}: it changed since it was read`
          : code === "TASK_ALREADY_CLAIMED"
            ? `Task${resource?.label ? ` ${resource.label}` : ""} was already claimed`
            : `${args.tool} failed (${code})`,
      resource,
    });
    return null;
  },
});

/** get_workspace_info: the connection's workspace, its members and its presence. */
export const getWorkspaceInfo = internalMutation({
  args: { principal },
  returns: v.object({
    userId: v.id("users"),
    client: v.string(),
    workspaces: v.array(
      v.object({
        id: v.id("workspaces"),
        name: v.string(),
        role: roleValidator,
        contextApproval: contextApprovalValidator,
        memberCount: v.number(),
        isDefault: v.boolean(),
      }),
    ),
    members: v.array(
      v.object({ userId: v.id("users"), name: v.string(), role: roleValidator }),
    ),
    membersTruncated: v.boolean(),
    connection: v.object({
      connectionId: v.id("agent_connections"),
      client: v.string(),
      lastMcpActionAt: v.union(v.number(), v.null()),
      lastSyncAt: v.union(v.number(), v.null()),
    }),
  }),
  handler: async (ctx, args) => {
    const session = await requireAgent(ctx, args.principal);
    // Report the timestamps as they were before this call touched them.
    const { connection } = session;
    await recordAgentAction(ctx, session);
    const workspace = await ctx.db.get(session.workspaceId);
    const rows = await ctx.db
      .query("workspace_members")
      .withIndex("by_workspace_and_user", (q) =>
        q.eq("workspaceId", session.workspaceId),
      )
      .take(1000);
    // Members are listed for ownership proposals: ids, names and roles only,
    // never emails, and never another workspace's members.
    const members = [];
    for (const row of rows.slice(0, MEMBER_LIMIT)) {
      const user = await ctx.db.get(row.userId);
      if (!user) continue;
      members.push({
        userId: user._id,
        name: user.name?.trim() || "Workspace member",
        role: row.role,
      });
    }
    await recordActivity(ctx, session, {
      tool: "get_workspace_info",
      kind: "read",
      summary: "Read workspace info",
    });
    return {
      userId: session.user._id,
      client: connection.client,
      // A connection is scoped to exactly one workspace, which is its default.
      workspaces: workspace
        ? [
            {
              id: workspace._id,
              name: workspace.name,
              role: session.membership.role,
              contextApproval: workspace.contextApproval ?? "manual",
              memberCount: rows.length,
              isDefault: true,
            },
          ]
        : [],
      members,
      membersTruncated: rows.length > MEMBER_LIMIT,
      connection: {
        connectionId: connection._id,
        client: connection.client,
        lastMcpActionAt: connection.lastMcpActionAt ?? null,
        lastSyncAt: connection.lastSyncAt ?? null,
      },
    };
  },
});

/**
 * list_files: a folder's immediate children (root by default), its whole
 * subtree flattened when `recursive`, or name matches within the subtree when
 * `query` has a term (see matchesQuery; a blank query is no query). Children
 * sort by name; subtrees and matches by path.
 */
export const listFiles = internalMutation({
  args: {
    principal,
    workspaceId: v.optional(v.string()),
    folderId: v.optional(v.string()),
    path: v.optional(v.string()),
    recursive: v.optional(v.boolean()),
    query: v.optional(v.string()),
  },
  returns: v.object({
    folder: v.object({ id: v.union(v.id("folders"), v.null()), path: v.string() }),
    folders: v.array(folderRowValidator),
    files: v.array(fileRowValidator),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const session = await agentCall(ctx, args.principal);
    const workspaceId = resolveAgentWorkspace(session, args.workspaceId);
    const folder = await folderArg(ctx, workspaceId, { id: args.folderId, path: args.path }, "path");
    const rootId = folder?._id ?? null;
    const base = await folderPath(ctx, rootId);
    const terms = queryTerms(args.query ?? "");
    // The query is the assistant's own text, so the summary leaves it out.
    await recordActivity(ctx, session, {
      tool: "list_files",
      kind: "read",
      summary: terms.length > 0 ? `Searched file names in ${base}` : `Listed ${base}`,
      ...(rootId ? { resource: { type: "folder" as const, id: rootId, label: base } } : {}),
    });

    if (terms.length === 0 && !args.recursive) {
      const folders = await listChildFolders(ctx, workspaceId, folder?._id, LIST_LIMIT + 1);
      const files = await listChildFiles(ctx, workspaceId, folder?._id, LIST_LIMIT + 1);
      return {
        folder: { id: rootId, path: base },
        folders: folders
          .slice(0, LIST_LIMIT)
          .sort((a, b) => byName(a.name, b.name))
          .map((f) => toFolderRow(f, joinPath(base, f.name))),
        files: files
          .slice(0, LIST_LIMIT)
          .sort((a, b) => byName(a.name, b.name))
          .map((f) => toFileRow(f, joinPath(base, f.name))),
        truncated: folders.length > LIST_LIMIT || files.length > LIST_LIMIT,
      };
    }

    const index = await loadFolderIndex(ctx, workspaceId);
    let folders = index.folders.filter((f) => isWithin(index, f.parentId, rootId));
    const subtreeFolderIds = folders.map((f) => f._id);
    /** Up to `limit` + 1 live files in the folder's subtree. */
    const filesInScope = async (limit: number) => {
      if (!rootId)
        return await ctx.db
          .query("files")
          .withIndex("by_workspace_and_deleted_at_and_parent", (q) =>
            q.eq("workspaceId", workspaceId).eq("deletedAt", undefined),
          )
          .take(limit + 1);
      const found: Doc<"files">[] = [];
      for (const id of [rootId, ...subtreeFolderIds]) {
        if (found.length > limit) break;
        found.push(...(await listChildFiles(ctx, workspaceId, id, limit + 1 - found.length)));
      }
      return found;
    };
    let files: Doc<"files">[];
    let truncated = index.truncated;
    if (terms.length > 0) {
      // One rule for folders and files (lib/names.ts matchesQuery), applied
      // to a bounded scan of the subtree; `truncated` also means the scan
      // stopped early. Name-index hits add word matches beyond the scan.
      folders = folders.filter((f) => matchesQuery(f.name, terms));
      const scanned = await filesInScope(LIST_SEARCH_SCAN);
      if (scanned.length > LIST_SEARCH_SCAN) truncated = true;
      const hits = await ctx.db
        .query("files")
        .withSearchIndex("search_name", (q) =>
          // A few terms are plenty for candidates; search queries are capped.
          q.search("name", terms.slice(0, 8).join(" ")).eq("workspaceId", workspaceId).eq("deletedAt", undefined),
        )
        .take(LIST_LIMIT + 1);
      const byId = new Map([...scanned.slice(0, LIST_SEARCH_SCAN), ...hits].map((f) => [f._id, f] as const));
      files = [...byId.values()].filter(
        (f) => isWithin(index, f.parentId, rootId) && matchesQuery(f.name, terms),
      );
    } else {
      files = await filesInScope(LIST_LIMIT);
    }
    const folderRows = folders
      .map((f) => toFolderRow(f, index.folderPath(f._id)))
      .sort((a, b) => byName(a.path, b.path));
    const fileRows = files
      .map((f) => toFileRow(f, index.filePath(f)))
      .sort((a, b) => byName(a.path, b.path));
    return {
      folder: { id: rootId, path: base },
      folders: folderRows.slice(0, LIST_LIMIT),
      files: fileRows.slice(0, LIST_LIMIT),
      truncated: truncated || folderRows.length > LIST_LIMIT || fileRows.length > LIST_LIMIT,
    };
  },
});

export const searchFiles = internalMutation({
  args: {
    principal,
    workspaceId: v.optional(v.string()),
    query: v.string(),
    limit: v.number(),
  },
  returns: v.array(
    v.object({
      file: fileRowValidator,
      snippet: v.string(),
      match: v.union(v.literal("name"), v.literal("content")),
    }),
  ),
  handler: async (ctx, args) => {
    const session = await agentCall(ctx, args.principal);
    const workspaceId = resolveAgentWorkspace(session, args.workspaceId);
    const results = await searchFilesCore(ctx, workspaceId, args.query, args.limit);
    const index = await loadFolderIndex(ctx, workspaceId);
    await recordActivity(ctx, session, {
      tool: "search_files",
      kind: "read",
      summary: `Searched files (${results.length} result${results.length === 1 ? "" : "s"})`,
    });
    return results.map((r) => ({ ...r, file: withPath(index, r.file) }));
  },
});

/** read_file by id, or by path in the connection's workspace. */
export const readFile = internalMutation({
  args: {
    principal,
    fileId: v.optional(v.string()),
    path: v.optional(v.string()),
    /** An earlier version to read; the latest when omitted. */
    version: v.optional(v.number()),
  },
  returns: v.object({
    file: fileRowValidator,
    content: v.union(v.string(), v.null()),
    /** The version `content` belongs to; file.version stays the latest. */
    version: v.number(),
  }),
  handler: async (ctx, args) => {
    const session = await agentCall(ctx, args.principal);
    if ((args.fileId === undefined) === (args.path === undefined))
      throw new ConvexError({ code: "INVALID_INPUT", field: "file_id" });
    let file: Doc<"files">;
    if (args.fileId !== undefined) {
      file = await getFileInWorkspace(ctx, args.fileId, session.workspaceId);
    } else {
      const found = await resolvePath(ctx, session.workspaceId, args.path!);
      if (found?.kind !== "file")
        throw new ConvexError({
          code: "PATH_NOT_FOUND",
          path: args.path!,
          expected: "file",
          ...(found ? { found: "folder" } : {}),
        });
      file = found.file;
    }
    const row = toFileRow(file, await filePath(ctx, file));
    const readVersion = args.version ?? file.version;
    await recordActivity(ctx, session, {
      tool: "read_file",
      kind: "read",
      summary: `Read ${row.path} v${readVersion}`,
      resource: fileResource(row),
    });
    if (args.version !== undefined && args.version !== file.version) {
      const revision = Number.isSafeInteger(args.version)
        ? await ctx.db
            .query("file_revisions")
            .withIndex("by_file_and_version", (q) =>
              q.eq("fileId", file._id).eq("version", args.version!))
            .unique()
        : null;
      if (!revision)
        throw new ConvexError({
          code: "INVALID_INPUT",
          field: "version",
          message: `${file.name} has no version ${args.version}; its latest is ${file.version}. get_file_versions lists them.`,
        });
      return {
        file: row,
        // Same placeholder as the head, so walking a binary's versions never errors.
        content: revision.storageId ? "binary: view or download in the dashboard" : revision.content,
        version: revision.version,
      };
    }
    return {
      file: row,
      content: file.storageId ? "binary: view or download in the dashboard" : (file.content ?? null),
      version: file.version,
    };
  },
});

export const getFileVersions = internalMutation({
  args: { principal, fileId: v.string(), limit: v.number() },
  returns: v.object({
    file: fileRowValidator,
    versions: v.array(
      v.object({
        version: v.number(),
        createdAt: v.number(),
        actor: actorValidator,
        sizeBytes: v.number(),
        /** Against the version before it; null for binary revisions. */
        change: v.union(
          v.object({ linesAdded: v.number(), linesRemoved: v.number() }),
          v.null(),
        ),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const session = await agentCall(ctx, args.principal);
    const limit = boundedInt(args.limit, 1, 100);
    const file = await getFileInWorkspace(ctx, args.fileId, session.workspaceId);
    const revisions = await ctx.db
      .query("file_revisions")
      .withIndex("by_file_and_version", (q) => q.eq("fileId", file._id))
      .order("desc")
      // One extra so the oldest listed version has something to compare to.
      .take(limit + 1);
    const encoder = new TextEncoder();
    const row = toFileRow(file, await filePath(ctx, file));
    await recordActivity(ctx, session, {
      tool: "get_file_versions",
      kind: "read",
      summary: `Listed versions of ${row.path}`,
      resource: fileResource(row),
    });
    return {
      file: row,
      // Sizes and line counts only: revision content never leaves through this function.
      versions: revisions.slice(0, limit).map((revision, i) => {
        const previous = revisions[i + 1];
        const comparable =
          revision.storageId === undefined &&
          previous?.storageId === undefined &&
          (previous !== undefined || revision.version === 1);
        return {
          version: revision.version,
          createdAt: revision.createdAt,
          actor: revision.actor,
          sizeBytes: revision.size ?? encoder.encode(revision.content).byteLength,
          change: comparable ? lineChanges(previous?.content ?? "", revision.content) : null,
        };
      }),
    };
  },
});

export const createDocument = internalMutation({
  args: {
    principal,
    workspaceId: v.optional(v.string()),
    parentId: v.optional(v.string()),
    /** Alternative to parentId; the folder must already exist. */
    folderPath: v.optional(v.string()),
    name: v.string(),
    mimeType: v.string(),
    content: v.string(),
  },
  returns: fileRowValidator,
  handler: async (ctx, args) => {
    const session = await agentCall(ctx, args.principal, { write: true });
    const workspaceId = resolveAgentWorkspace(session, args.workspaceId);
    if (!TEXT_MIME_TYPES.has(args.mimeType))
      throw new ConvexError({ code: "INVALID_INPUT", field: "mimeType" });
    const parent = await folderArg(
      ctx,
      workspaceId,
      { id: args.parentId, path: args.folderPath },
      "folder_path",
    );
    const file = await createDocumentCore(ctx, {
      workspaceId,
      parentId: parent?._id,
      name: args.name,
      mimeType: args.mimeType,
      content: args.content,
      actor: session.actor,
    });
    const row = toFileRow(file, await filePath(ctx, file));
    await recordActivity(ctx, session, {
      tool: "create_document",
      kind: "write",
      summary: `Created ${row.path} (v${row.version})`,
      resource: fileResource(row),
    });
    return row;
  },
});

export const updateDocument = internalMutation({
  args: {
    principal,
    fileId: v.string(),
    content: v.string(),
    expectedVersion: v.number(),
  },
  returns: fileRowValidator,
  handler: async (ctx, args) => {
    const session = await agentCall(ctx, args.principal, { write: true });
    const file = await getFileInWorkspace(ctx, args.fileId, session.workspaceId);
    const updated = await updateDocumentCore(ctx, {
      file,
      content: args.content,
      expectedVersion: args.expectedVersion,
      actor: session.actor,
    });
    const row = toFileRow(updated, await filePath(ctx, updated));
    await recordActivity(ctx, session, {
      tool: "update_document",
      kind: "write",
      summary: `Saved ${row.path} as v${row.version}`,
      resource: fileResource(row),
    });
    return row;
  },
});

/** create_folder: `mkdir -p`, idempotent (`created` false when it existed). */
export const createFolder = internalMutation({
  args: { principal, workspaceId: v.optional(v.string()), path: v.string() },
  returns: v.object({ folder: folderRowValidator, created: v.boolean() }),
  handler: async (ctx, args) => {
    const session = await agentCall(ctx, args.principal, { write: true });
    const workspaceId = resolveAgentWorkspace(session, args.workspaceId);
    const { folder, created } = await ensureFolderPathCore(ctx, {
      workspaceId,
      path: args.path,
      actor: session.actor,
    });
    const row = toFolderRow(folder, await folderPath(ctx, folder._id));
    await recordActivity(ctx, session, {
      tool: "create_folder",
      kind: "write",
      summary: created ? `Created folder ${row.path}` : `Folder ${row.path} already existed`,
      resource: { type: "folder", id: row.id, label: row.path },
    });
    return { folder: row, created };
  },
});

/** move_file: version N+1 with the same content, in the destination folder. */
export const moveFile = internalMutation({
  args: {
    principal,
    fileId: v.string(),
    expectedVersion: v.number(),
    toFolderId: v.optional(v.string()),
    toFolderPath: v.optional(v.string()),
    newName: v.optional(v.string()),
  },
  returns: fileRowValidator,
  handler: async (ctx, args) => {
    const session = await agentCall(ctx, args.principal, { write: true });
    if (args.toFolderId === undefined && args.toFolderPath === undefined)
      throw new ConvexError({ code: "INVALID_INPUT", field: "to_folder_path" });
    const file = await getFileInWorkspace(ctx, args.fileId, session.workspaceId);
    const dest = await folderArg(
      ctx,
      session.workspaceId,
      { id: args.toFolderId, path: args.toFolderPath },
      "to_folder_path",
    );
    const moved = await moveFileCore(ctx, {
      file,
      parentId: dest?._id ?? null,
      expectedVersion: args.expectedVersion,
      name: args.newName,
      actor: session.actor,
    });
    const row = toFileRow(moved, await filePath(ctx, moved));
    await recordActivity(ctx, session, {
      tool: "move_file",
      kind: "write",
      summary: `Moved file to ${row.path} (v${row.version})`,
      resource: fileResource(row),
    });
    return row;
  },
});

/** move_folder: the folder and its subtree move; revision N+1. */
export const moveFolder = internalMutation({
  args: {
    principal,
    folderId: v.string(),
    expectedRevision: v.number(),
    toFolderId: v.optional(v.string()),
    toFolderPath: v.optional(v.string()),
    newName: v.optional(v.string()),
  },
  returns: folderRowValidator,
  handler: async (ctx, args) => {
    const session = await agentCall(ctx, args.principal, { write: true });
    if (args.toFolderId === undefined && args.toFolderPath === undefined)
      throw new ConvexError({ code: "INVALID_INPUT", field: "to_folder_path" });
    const folder = await getFolderInWorkspace(ctx, args.folderId, session.workspaceId);
    const dest = await folderArg(
      ctx,
      session.workspaceId,
      { id: args.toFolderId, path: args.toFolderPath },
      "to_folder_path",
    );
    const moved = await moveFolderCore(ctx, {
      folder,
      parentId: dest?._id ?? null,
      expectedRevision: args.expectedRevision,
      name: args.newName,
      actor: session.actor,
    });
    const row = toFolderRow(moved, await folderPath(ctx, moved._id));
    await recordActivity(ctx, session, {
      tool: "move_folder",
      kind: "write",
      summary: `Moved folder to ${row.path}`,
      resource: { type: "folder", id: row.id, label: row.path },
    });
    return row;
  },
});

export const syncWorkspace = internalMutation({
  args: {
    principal,
    workspaceId: v.optional(v.string()),
    /** From the MCP cursor; omit both for a snapshot. */
    sinceSeq: v.optional(v.number()),
    cursorWorkspaceId: v.optional(v.string()),
  },
  returns: v.object({
    workspace: v.object({ id: v.id("workspaces"), name: v.string() }),
    context: contextValidator,
    pendingProposals: v.array(
      v.object({
        id: v.id("context_proposals"),
        field: contextFieldValidator,
        operation: v.union(v.literal("add"), v.literal("resolve"), v.literal("remove")),
        rationale: v.string(),
        proposedValue: v.string(),
        supersedes: v.union(v.string(), v.null()),
        status: v.literal("pending"),
        createdBy: actorValidator,
        createdAt: v.number(),
      }),
    ),
    changedFiles: v.array(fileRowValidator),
    filesTruncated: v.boolean(),
    /** Every live folder, sorted by path, on every sync. */
    folders: v.array(folderRowValidator),
    foldersTruncated: v.boolean(),
    recentWork: v.array(publishedWorkValidator),
    workTruncated: v.boolean(),
    tasks: v.array(taskValidator),
    tasksTruncated: v.boolean(),
    events: v.array(eventValidator),
    eventsTruncated: v.boolean(),
    headSeq: v.number(),
    cursorSeq: v.number(),
  }),
  handler: async (ctx, args) => {
    // Presence and syncedContextRevision are written together after the
    // sync below, in one patch.
    const session = await requireAgent(ctx, args.principal);
    const workspaceId = resolveAgentWorkspace(session, args.workspaceId);
    if (
      args.cursorWorkspaceId !== undefined &&
      args.cursorWorkspaceId !== workspaceId
    )
      throw new ConvexError({ code: "INVALID_CURSOR" });
    const result = await syncCore(ctx, workspaceId, args.sinceSeq);
    const index = await loadFolderIndex(ctx, workspaceId);
    const folders = index.folders
      .map((f) => toFolderRow(f, index.folderPath(f._id)))
      .sort((a, b) => byName(a.path, b.path));
    // One row per connection, so two connections of the same person and
    // client don't overwrite each other's cursor.
    const cursor = await ctx.db
      .query("sync_cursors")
      .withIndex("by_agent_connection", (q) =>
        q.eq("agentConnectionId", session.connection._id),
      )
      .unique();
    const now = Date.now();
    if (cursor) {
      await ctx.db.patch(cursor._id, {
        cursor: result.cursorSeq,
        updatedBy: session.actor,
        revision: cursor.revision + 1,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("sync_cursors", {
        workspaceId,
        userId: session.user._id,
        client: session.connection.client,
        agentConnectionId: session.connection._id,
        cursor: result.cursorSeq,
        updatedBy: session.actor,
        revision: 1,
        updatedAt: now,
      });
    }
    // Every sync result carries the full approved context, so this is what
    // the connection has now received; reads never advance it.
    const contextRevision = result.context.revision;
    const previous = session.connection.syncedContextRevision;
    await recordAgentAction(ctx, session, { sync: true, syncedContextRevision: contextRevision });
    await recordActivity(ctx, session, {
      tool: "sync_workspace",
      kind: "sync",
      summary:
        previous !== undefined && previous < contextRevision
          ? `Synced context v${contextRevision} (was v${previous})`
          : `Synced context v${contextRevision}`,
      resource: { type: "context", id: workspaceId, label: `Context v${contextRevision}` },
      contextRevision,
      ...(previous !== undefined ? { previousSyncedContextRevision: previous } : {}),
    });
    return {
      ...result,
      changedFiles: result.changedFiles.map((f) => withPath(index, f)),
      folders: folders.slice(0, SYNC_FOLDER_LIMIT),
      foldersTruncated: index.truncated || folders.length > SYNC_FOLDER_LIMIT,
    };
  },
});

export const proposeContextChange = internalMutation({
  args: {
    principal,
    workspaceId: v.optional(v.string()),
    operation: v.optional(v.union(v.literal("add"), v.literal("resolve"), v.literal("remove"))),
    entryId: v.optional(v.string()),
    supersedes: v.optional(v.string()),
    expectedVersion: v.optional(v.number()),
    field: contextFieldValidator,
    proposedValue: v.optional(v.string()),
    rationale: v.string(),
    sourceFileIds: v.array(v.string()),
    /** Required for ownership (proposedValue is then the area); else omitted. */
    ownerUserId: v.optional(v.string()),
  },
  returns: v.object({
    proposal: proposalValidator,
    contextRevision: v.number(),
  }),
  handler: async (ctx, args) => {
    const session = await agentCall(ctx, args.principal, { write: true });
    const workspaceId = resolveAgentWorkspace(session, args.workspaceId);
    const revisionBefore = await currentContextRevision(ctx, workspaceId);
    const proposal = await proposeContextChangeCore(ctx, {
      workspaceId,
      field: args.field,
      operation: args.operation,
      entryId: args.entryId,
      supersedes: args.supersedes,
      expectedVersion: args.expectedVersion,
      proposedValue: (args.operation ?? "add") === "add"
        ? boundedText(args.proposedValue ?? "", 2000, "proposedValue") : undefined,
      rationale: boundedText(args.rationale, 2000, "rationale"),
      sourceFileIds: args.sourceFileIds,
      ownerUserId: args.ownerUserId,
      actor: session.actor,
    });
    // An applied change by an agent that already had the previous version
    // leaves it holding the new one: it wrote the only difference. Pending
    // proposals don't count; the agent receives the approval when it syncs.
    if (
      proposal.status === "applied" &&
      session.connection.syncedContextRevision === revisionBefore
    ) {
      const revisionAfter = await currentContextRevision(ctx, workspaceId);
      if (revisionAfter === revisionBefore + 1)
        await ctx.db.patch(session.connection._id, { syncedContextRevision: revisionAfter });
    }
    // Field and status only: never the proposed text or the rationale.
    const field = proposal.field.replaceAll("_", " ");
    await recordActivity(ctx, session, {
      tool: "propose_context_change",
      kind: "propose",
      summary:
        proposal.status === "applied"
          ? `Applied a ${field} change`
          : `Proposed a ${field} change (pending approval)`,
      resource: { type: "proposal", id: proposal._id, label: field },
    });
    return {
      proposal: toProposal(proposal),
      contextRevision: proposal.contextRevision ?? 0,
    };
  },
});

export const getApprovals = internalMutation({
  args: {
    principal,
    workspaceId: v.optional(v.string()),
    /** Omit for every status. */
    status: v.optional(proposalStatusValidator),
    limit: v.number(),
  },
  returns: v.array(
    v.object({
      proposal: proposalValidator,
      contextRevision: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const session = await agentCall(ctx, args.principal);
    const workspaceId = resolveAgentWorkspace(session, args.workspaceId);
    const limit = boundedInt(args.limit, 1, 50);
    const proposals = await listProposals(ctx, workspaceId, args.status, limit);
    await recordActivity(ctx, session, {
      tool: "get_approvals",
      kind: "read",
      summary: `Checked ${args.status ?? "all"} proposals (${proposals.length})`,
    });
    return proposals.map((proposal) => ({
      proposal: toProposal(proposal),
      contextRevision: proposal.contextRevision ?? 0,
    }));
  },
});

/**
 * manage_task: list needs only read scope, every other operation needs write
 * scope, so read-only connections can still see the task list. Ownership is
 * by person (session.user), whichever of their assistants acts.
 */
export const manageTask = internalMutation({
  args: {
    principal,
    workspaceId: v.optional(v.string()),
    operation: v.union(
      v.literal("list"),
      v.literal("create"),
      v.literal("claim"),
      v.literal("update"),
      v.literal("complete"),
    ),
    taskId: v.optional(v.string()),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    /** list: filter (omit for all). update: "open" or "in_progress". */
    status: v.optional(taskStatusValidator),
    expectedVersion: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  returns: v.union(
    v.object({ task: taskValidator }),
    v.object({ tasks: v.array(taskValidator) }),
  ),
  handler: async (ctx, args) => {
    const { operation } = args;
    const session = await agentCall(ctx, args.principal, {
      write: operation !== "list",
    });
    const workspaceId = resolveAgentWorkspace(session, args.workspaceId);
    if (operation === "list") {
      const limit = boundedInt(args.limit ?? 50, 1, 100);
      const tasks = await listTasks(ctx, workspaceId, args.status, limit);
      await recordActivity(ctx, session, {
        tool: "manage_task",
        kind: "read",
        summary: `Listed ${args.status ?? "all"} tasks (${tasks.length})`,
      });
      return { tasks: await Promise.all(tasks.map((task) => toTask(ctx, task))) };
    }
    const taskActivity = (task: Doc<"tasks">, verb: string) =>
      recordActivity(ctx, session, {
        tool: "manage_task",
        kind: "task",
        summary: `${verb} a task`,
        resource: { type: "task", id: task._id, label: task.title },
      });
    if (operation === "create") {
      const task = await createTaskCore(ctx, {
        workspaceId,
        title: args.title ?? "",
        description: args.description ?? "",
        actor: session.actor,
      });
      await taskActivity(task, "Created");
      return { task: await toTask(ctx, task) };
    }
    if (args.taskId === undefined || args.expectedVersion === undefined)
      throw new ConvexError({ code: "INVALID_INPUT" });
    const task = await getTaskInWorkspace(ctx, args.taskId, workspaceId);
    const base = {
      task,
      expectedVersion: args.expectedVersion,
      userId: session.user._id,
      actor: session.actor,
    };
    const updated =
      operation === "claim"
        ? await claimTaskCore(ctx, base)
        : operation === "complete"
          ? await completeTaskCore(ctx, base)
          : await updateTaskCore(ctx, {
              ...base,
              title: args.title,
              description: args.description,
              status: args.status,
            });
    await taskActivity(
      updated,
      operation === "claim" ? "Claimed" : operation === "complete" ? "Completed" : "Updated",
    );
    return { task: await toTask(ctx, updated) };
  },
});

export const publishWork = internalMutation({
  args: {
    principal,
    workspaceId: v.optional(v.string()),
    kind: v.union(v.literal("deliverable"), v.literal("finding")),
    title: v.string(),
    summary: v.string(),
    fileIds: v.array(v.string()),
  },
  returns: publishedWorkValidator,
  handler: async (ctx, args) => {
    const session = await agentCall(ctx, args.principal, { write: true });
    const workspaceId = resolveAgentWorkspace(session, args.workspaceId);
    const work = await publishWorkCore(ctx, {
      workspaceId,
      kind: args.kind,
      title: args.title,
      summary: args.summary,
      fileIds: await checkSourceFiles(ctx, workspaceId, args.fileIds),
      actor: session.actor,
    });
    // The title labels the work; its summary stays out of the activity feed.
    await recordActivity(ctx, session, {
      tool: "publish_work",
      kind: "publish",
      summary: `Published a ${work.kind}${work.fileIds.length > 0 ? ` covering ${work.fileIds.length} file${work.fileIds.length === 1 ? "" : "s"}` : ""}`,
      resource: { type: "published_work", id: work._id, label: work.title },
    });
    return toPublishedWork(work);
  },
});
