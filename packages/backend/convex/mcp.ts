// Agent entry points for the MCP server. Every function takes the caller's
// agent connection token, verifies it in Convex (lib/agent.ts requireAgent),
// and then runs the same core operations as the dashboard (lib/ops.ts) with
// agent attribution. These are mutations, even for reads, because every agent
// call records lastMcpActionAt. There is deliberately no way to decide a
// proposal or change the approved context from here.
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  requireAgent,
  resolveAgentWorkspace,
  touchConnection as recordAgentAction,
  type AgentSession,
} from "./lib/agent";
import {
  checkSourceFiles,
  createDocumentCore,
  getFileInWorkspace,
  listProposals,
  proposeContextChangeCore,
  publishWorkCore,
  searchFilesCore,
  syncCore,
  toFileMetadata,
  toPublishedWork,
  toProposal,
  updateDocumentCore,
} from "./lib/ops";
import {
  actorValidator,
  contextFieldValidator,
  contextValidator,
  eventValidator,
  fileMetadataValidator,
  proposalStatusValidator,
  proposalValidator,
  publishedWorkValidator,
  roleValidator,
} from "./lib/validators";

const LIST_LIMIT = 200;
const TEXT_MIME_TYPES = new Set(["text/markdown", "text/plain"]);

async function agentCall(
  ctx: MutationCtx,
  token: string,
  options: { sync?: boolean } = {},
): Promise<AgentSession> {
  const session = await requireAgent(ctx, token);
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

/** Used by the MCP server to authenticate a request before running tools. Read-only. */
export const verifyToken = query({
  args: { token: v.string() },
  returns: v.object({
    userId: v.id("users"),
    userName: v.string(),
    client: v.string(),
    connectionId: v.id("agent_connections"),
    workspaceId: v.id("workspaces"),
  }),
  handler: async (ctx, { token }) => {
    const session = await requireAgent(ctx, token);
    return {
      userId: session.user._id,
      userName: session.actor.userName ?? session.actor.label,
      client: session.connection.client,
      connectionId: session.connection._id,
      workspaceId: session.workspaceId,
    };
  },
});

/**
 * Presence for a failed agent call. A failing tool mutation rolls back its own
 * touch, so the MCP server calls this after a call fails (never after one
 * succeeds) to keep "last MCP action" honest. Records no sync.
 */
export const touchConnection = mutation({
  args: { token: v.string() },
  returns: v.null(),
  handler: async (ctx, { token }) => {
    await agentCall(ctx, token);
    return null;
  },
});

export const listWorkspaces = mutation({
  args: { token: v.string() },
  returns: v.array(
    v.object({
      id: v.id("workspaces"),
      name: v.string(),
      role: roleValidator,
      memberCount: v.number(),
      isDefault: v.boolean(),
    }),
  ),
  handler: async (ctx, { token }) => {
    // get_workspace_info calls this and then getConnection, which records the
    // action; touching here too would make it report this very call.
    const session = await requireAgent(ctx, token);
    const workspace = await ctx.db.get(session.workspaceId);
    if (!workspace) return [];
    const members = await ctx.db
      .query("workspace_members")
      .withIndex("by_workspace_and_user", (q) =>
        q.eq("workspaceId", session.workspaceId),
      )
      .take(1000);
    // A connection is scoped to exactly one workspace, which is its default.
    return [
      {
        id: workspace._id,
        name: workspace.name,
        role: session.membership.role,
        memberCount: members.length,
        isDefault: true,
      },
    ];
  },
});

const MEMBER_LIMIT = 100;

/**
 * Members of the connection's workspace, so an agent can name an owner in an
 * ownership proposal. Ids, names and roles only: never emails, and never
 * another workspace's members.
 */
export const listMembers = mutation({
  args: { token: v.string() },
  returns: v.object({
    members: v.array(
      v.object({ userId: v.id("users"), name: v.string(), role: roleValidator }),
    ),
    truncated: v.boolean(),
  }),
  handler: async (ctx, { token }) => {
    // Like listWorkspaces: get_workspace_info records the action via getConnection.
    const session = await requireAgent(ctx, token);
    const rows = await ctx.db
      .query("workspace_members")
      .withIndex("by_workspace_and_user", (q) =>
        q.eq("workspaceId", session.workspaceId),
      )
      .take(MEMBER_LIMIT + 1);
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
    return { members, truncated: rows.length > MEMBER_LIMIT };
  },
});

export const getConnection = mutation({
  args: { token: v.string() },
  returns: v.object({
    connectionId: v.id("agent_connections"),
    workspaceId: v.id("workspaces"),
    client: v.string(),
    displayName: v.union(v.string(), v.null()),
    lastMcpActionAt: v.union(v.number(), v.null()),
    lastSyncAt: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, { token }) => {
    // Report the timestamps as they were before this call touched them.
    const session = await requireAgent(ctx, token);
    const { connection } = session;
    await recordAgentAction(ctx, session);
    return {
      connectionId: connection._id,
      workspaceId: connection.workspaceId,
      client: connection.client,
      displayName: connection.displayName ?? null,
      lastMcpActionAt: connection.lastMcpActionAt ?? null,
      lastSyncAt: connection.lastSyncAt ?? null,
    };
  },
});

export const listFiles = mutation({
  args: {
    token: v.string(),
    workspaceId: v.optional(v.string()),
    folderId: v.optional(v.string()),
    query: v.optional(v.string()),
  },
  returns: v.object({
    files: v.array(fileMetadataValidator),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const session = await agentCall(ctx, args.token);
    const workspaceId = resolveAgentWorkspace(session, args.workspaceId);
    let folderId: Id<"folders"> | undefined;
    if (args.folderId !== undefined) {
      const id = ctx.db.normalizeId("folders", args.folderId);
      const folder = id ? await ctx.db.get(id) : null;
      if (!folder || folder.workspaceId !== workspaceId)
        throw new ConvexError({ code: "INVALID_INPUT", field: "folderId" });
      folderId = folder._id;
    }
    const needle = args.query?.trim();
    let rows;
    if (needle) {
      // Name search runs over the whole workspace through the search index,
      // so `truncated` means more files matched than were returned.
      rows = await ctx.db
        .query("files")
        .withSearchIndex("search_name", (q) => {
          const search = q.search("name", needle).eq("workspaceId", workspaceId);
          return folderId ? search.eq("parentId", folderId) : search;
        })
        .take(LIST_LIMIT + 1);
    } else if (folderId) {
      rows = await ctx.db
        .query("files")
        .withIndex("by_workspace_and_parent", (q) =>
          q.eq("workspaceId", workspaceId).eq("parentId", folderId),
        )
        .take(LIST_LIMIT + 1);
    } else {
      rows = await ctx.db
        .query("files")
        .withIndex("by_workspace_and_updated_at", (q) =>
          q.eq("workspaceId", workspaceId),
        )
        .order("desc")
        .take(LIST_LIMIT + 1);
    }
    const truncated = rows.length > LIST_LIMIT;
    const files = rows.slice(0, LIST_LIMIT);
    return { files: files.map(toFileMetadata), truncated };
  },
});

export const searchFiles = mutation({
  args: {
    token: v.string(),
    workspaceId: v.optional(v.string()),
    query: v.string(),
    limit: v.number(),
  },
  returns: v.array(
    v.object({
      file: fileMetadataValidator,
      snippet: v.string(),
      match: v.union(v.literal("name"), v.literal("content")),
    }),
  ),
  handler: async (ctx, args) => {
    const session = await agentCall(ctx, args.token);
    const workspaceId = resolveAgentWorkspace(session, args.workspaceId);
    return await searchFilesCore(ctx, workspaceId, args.query, args.limit);
  },
});

export const readFile = mutation({
  args: { token: v.string(), fileId: v.string() },
  returns: v.object({
    file: fileMetadataValidator,
    content: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const session = await agentCall(ctx, args.token);
    const file = await getFileInWorkspace(ctx, args.fileId, session.workspaceId);
    return { file: toFileMetadata(file), content: file.content ?? null };
  },
});

export const getFileVersions = mutation({
  args: { token: v.string(), fileId: v.string(), limit: v.number() },
  returns: v.object({
    file: fileMetadataValidator,
    versions: v.array(
      v.object({
        version: v.number(),
        createdAt: v.number(),
        actor: actorValidator,
        sizeBytes: v.number(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const session = await agentCall(ctx, args.token);
    const limit = boundedInt(args.limit, 1, 100);
    const file = await getFileInWorkspace(ctx, args.fileId, session.workspaceId);
    const revisions = await ctx.db
      .query("file_revisions")
      .withIndex("by_file_and_version", (q) => q.eq("fileId", file._id))
      .order("desc")
      .take(limit);
    const encoder = new TextEncoder();
    return {
      file: toFileMetadata(file),
      // Sizes only: revision content never leaves through this function.
      versions: revisions.map((revision) => ({
        version: revision.version,
        createdAt: revision.createdAt,
        actor: revision.actor,
        sizeBytes: encoder.encode(revision.content).byteLength,
      })),
    };
  },
});

export const createDocument = mutation({
  args: {
    token: v.string(),
    workspaceId: v.optional(v.string()),
    parentId: v.optional(v.string()),
    name: v.string(),
    mimeType: v.string(),
    content: v.string(),
  },
  returns: fileMetadataValidator,
  handler: async (ctx, args) => {
    const session = await agentCall(ctx, args.token);
    const workspaceId = resolveAgentWorkspace(session, args.workspaceId);
    if (!TEXT_MIME_TYPES.has(args.mimeType))
      throw new ConvexError({ code: "INVALID_INPUT", field: "mimeType" });
    let parentId;
    if (args.parentId !== undefined) {
      parentId = ctx.db.normalizeId("folders", args.parentId) ?? undefined;
      if (!parentId) throw new ConvexError({ code: "INVALID_PARENT_FOLDER" });
    }
    const file = await createDocumentCore(ctx, {
      workspaceId,
      parentId,
      name: args.name,
      mimeType: args.mimeType,
      content: args.content,
      actor: session.actor,
    });
    return toFileMetadata(file);
  },
});

export const updateDocument = mutation({
  args: {
    token: v.string(),
    fileId: v.string(),
    content: v.string(),
    expectedVersion: v.number(),
  },
  returns: fileMetadataValidator,
  handler: async (ctx, args) => {
    const session = await agentCall(ctx, args.token);
    const file = await getFileInWorkspace(ctx, args.fileId, session.workspaceId);
    const updated = await updateDocumentCore(ctx, {
      file,
      content: args.content,
      expectedVersion: args.expectedVersion,
      actor: session.actor,
    });
    return toFileMetadata(updated);
  },
});

export const syncWorkspace = mutation({
  args: {
    token: v.string(),
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
        rationale: v.string(),
        createdBy: actorValidator,
        createdAt: v.number(),
      }),
    ),
    changedFiles: v.array(fileMetadataValidator),
    filesTruncated: v.boolean(),
    recentWork: v.array(publishedWorkValidator),
    workTruncated: v.boolean(),
    events: v.array(eventValidator),
    eventsTruncated: v.boolean(),
    headSeq: v.number(),
    cursorSeq: v.number(),
  }),
  handler: async (ctx, args) => {
    const session = await agentCall(ctx, args.token, { sync: true });
    const workspaceId = resolveAgentWorkspace(session, args.workspaceId);
    if (
      args.cursorWorkspaceId !== undefined &&
      args.cursorWorkspaceId !== workspaceId
    )
      throw new ConvexError({ code: "INVALID_CURSOR" });
    const result = await syncCore(ctx, workspaceId, args.sinceSeq);
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
    return result;
  },
});

export const proposeContextChange = mutation({
  args: {
    token: v.string(),
    workspaceId: v.optional(v.string()),
    field: contextFieldValidator,
    proposedValue: v.string(),
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
    const session = await agentCall(ctx, args.token);
    const workspaceId = resolveAgentWorkspace(session, args.workspaceId);
    const proposal = await proposeContextChangeCore(ctx, {
      workspaceId,
      field: args.field,
      proposedValue: boundedText(args.proposedValue, 2000, "proposedValue"),
      rationale: boundedText(args.rationale, 2000, "rationale"),
      sourceFileIds: await checkSourceFiles(ctx, workspaceId, args.sourceFileIds),
      ownerUserId: args.ownerUserId,
      actor: session.actor,
    });
    return {
      proposal: toProposal(proposal),
      contextRevision: proposal.contextRevision ?? 0,
    };
  },
});

export const getApprovals = mutation({
  args: {
    token: v.string(),
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
    const session = await agentCall(ctx, args.token);
    const workspaceId = resolveAgentWorkspace(session, args.workspaceId);
    const limit = boundedInt(args.limit, 1, 50);
    const proposals = await listProposals(ctx, workspaceId, args.status, limit);
    return proposals.map((proposal) => ({
      proposal: toProposal(proposal),
      contextRevision: proposal.contextRevision ?? 0,
    }));
  },
});

export const publishWork = mutation({
  args: {
    token: v.string(),
    workspaceId: v.optional(v.string()),
    kind: v.union(v.literal("deliverable"), v.literal("finding")),
    title: v.string(),
    summary: v.string(),
    fileIds: v.array(v.string()),
  },
  returns: publishedWorkValidator,
  handler: async (ctx, args) => {
    const session = await agentCall(ctx, args.token);
    const workspaceId = resolveAgentWorkspace(session, args.workspaceId);
    const work = await publishWorkCore(ctx, {
      workspaceId,
      kind: args.kind,
      title: args.title,
      summary: args.summary,
      fileIds: await checkSourceFiles(ctx, workspaceId, args.fileIds),
      actor: session.actor,
    });
    return toPublishedWork(work);
  },
});
