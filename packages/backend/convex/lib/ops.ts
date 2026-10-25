// Core workspace operations shared by the dashboard (Convex Auth) and agent
// (MCP token) entry points. Callers authorize first and pass a verified actor
// and workspace; nothing here reads identity from arguments.
import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { type Actor, recordWorkspaceEvent } from "./auth";
import {
  assertNameFree,
  checkFileVersion,
  insertMetadataRevision,
  listSubtreeFiles,
  requireParentFolder,
  requireValidName,
  toFileMetadata,
} from "./fs";
import {
  detectConflict,
  findDuplicateProposal,
  isActive,
  markCompeting,
  toResolvedConflict,
} from "./conflicts";
import { nameKey } from "./names";

export { toFileMetadata };

type ReadCtx = QueryCtx | MutationCtx;

export type ContextField = Doc<"context_proposals">["field"];

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
  if (!file || file.deletedAt !== undefined || file.workspaceId !== workspaceId)
    throw new ConvexError({ code: "FILE_NOT_FOUND", fileId });
  return file;
}

/** Validate sources, preserving soft-deleted references already on the target. */
export async function checkSourceFiles(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
  fileIds: string[],
  existingFileIds: readonly string[] = [],
): Promise<Id<"files">[]> {
  const unique = [...new Set(fileIds)];
  if (unique.length > 20) throw new ConvexError({ code: "INVALID_INPUT" });
  const result: Id<"files">[] = [];
  for (const raw of unique) {
    const id = ctx.db.normalizeId("files", raw);
    const file = id ? await ctx.db.get(id) : null;
    if (
      !file || file.workspaceId !== workspaceId ||
      (file.deletedAt !== undefined && !existingFileIds.includes(raw))
    )
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
  await requireParentFolder(ctx, workspaceId, parentId);
  const { name, key } = requireValidName(args.name);
  // Convex has no unique indexes: reading the name-key ranges in the same
  // mutation as the insert makes concurrent creates of one name conflict.
  await assertNameFree(ctx, workspaceId, parentId, key);
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
    eventSummary?: string;
  },
): Promise<Doc<"files">> {
  const { file, actor, expectedVersion } = args;
  if (file.deletedAt !== undefined) throw new ConvexError({ code: "FILE_NOT_FOUND" });
  if (file.storageId) throw new ConvexError({ code: "BINARY_FILE", message: "Upload a new binary revision in the dashboard" });
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
    summary: args.eventSummary ?? `Updated ${file.name} to revision ${version}`,
    actor,
  });
  const updated = await ctx.db.get(file._id);
  if (!updated) throw new ConvexError({ code: "FILE_NOT_FOUND" });
  return updated;
}

/** Any workspace member may rename or delete; entry points authorize membership. */
export async function renameFileCore(
  ctx: MutationCtx,
  args: {
    file: Doc<"files">;
    name: string;
    expectedVersion: number;
    actor: Actor;
  },
) {
  const { file, actor, expectedVersion } = args;
  checkFileVersion(file, expectedVersion);
  const { name, key } = requireValidName(args.name);
  await assertNameFree(ctx, file.workspaceId, file.parentId, key, {
    fileId: file._id,
  });
  const now = Date.now();
  const version = file.version + 1;
  await ctx.db.patch(file._id, {
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
    kind: "file.renamed",
    entityType: "file",
    entityId: file._id,
    summary: `Renamed ${file.name} to ${name}`,
    actor,
  });
  return (await ctx.db.get(file._id))!;
}

export async function deleteFileCore(
  ctx: MutationCtx,
  args: {
    file: Doc<"files">;
    expectedVersion: number;
    actor: Actor;
  },
) {
  const { file, actor, expectedVersion } = args;
  checkFileVersion(file, expectedVersion);
  const now = Date.now();
  // Release the collision key while preserving the file and all content revisions.
  await ctx.db.patch(file._id, {
    deletedAt: now,
    deletedBy: actor,
    nameKey: undefined,
    revision: file.revision + 1,
    updatedAt: now,
    updatedBy: actor,
  });
  // This event is the tombstone returned by sync_workspace.events.
  await recordWorkspaceEvent(ctx, {
    workspaceId: file.workspaceId,
    kind: "file.deleted",
    entityType: "file",
    entityId: file._id,
    summary: `Deleted ${file.name}`,
    actor,
  });
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

/** Deterministic fallback IDs keep legacy reads stable until the backfill runs. */
export function normalizeContext(context: Doc<"structured_context">) {
  const entries = (
    key: "constraints" | "decisions" | "ownership" | "openQuestions",
  ) =>
    context[key].map((entry, index) => ({
      ...entry,
      id: entry.id ?? `${context._id}:${key}:${index}`,
    }));
  return {
    ...context,
    constraints: entries("constraints"),
    decisions: entries("decisions"),
    ownership: entries("ownership"),
    openQuestions: entries("openQuestions"),
  };
}

/**
 * Whether context proposals apply as soon as they're made ("automatic") or
 * wait in Approvals ("manual", the default). An owner's or admin's direct
 * dashboard edit is already a decision and doesn't go through here.
 */
export async function appliesImmediately(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
): Promise<boolean> {
  const workspace = await ctx.db.get(workspaceId);
  if (!workspace) throw new ConvexError({ code: "WORKSPACE_NOT_FOUND" });
  return workspace.contextApproval === "automatic";
}

/** Resolves or removes one constraint or open question entry. */
async function applyEntryOperation(
  ctx: MutationCtx,
  stored: Doc<"structured_context">,
  change: {
    field: ContextField;
    operation: "resolve" | "remove";
    entryId: string;
  },
  actor: Actor,
  now: number,
) {
  const normalized = normalizeContext(stored);
  const key = change.field === "constraint" ? "constraints" : "openQuestions";
  const entries =
    change.operation === "remove"
      ? normalized[key].filter((e) => e.id !== change.entryId)
      : normalized[key].map((e) =>
          e.id === change.entryId
            ? {
                ...e,
                status: "resolved" as const,
                resolvedBy: actor,
                resolvedAt: now,
              }
            : e,
        );
  await ctx.db.patch(stored._id, {
    constraints: normalized.constraints,
    decisions: normalized.decisions,
    ownership: normalized.ownership,
    openQuestions: normalized.openQuestions,
    [key]: entries,
    revision: stored.revision + 1,
    updatedBy: actor,
    updatedAt: now,
  });
}

/**
 * Whether a pending resolve/remove proposal's entry is gone or, for a
 * resolve, already resolved. Additions always have a target.
 */
export function entryTargetMissing(
  context: Doc<"structured_context">,
  proposal: Pick<Doc<"context_proposals">, "field" | "operation" | "entryId">,
): boolean {
  if (!proposal.operation) return false;
  const key = proposal.field === "constraint" ? "constraints" : "openQuestions";
  const target = normalizeContext(context)[key].find(
    (e) => e.id === proposal.entryId,
  );
  return (
    !target || (proposal.operation === "resolve" && target.status === "resolved")
  );
}

export async function proposeContextChangeCore(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    field: ContextField;
    /** For ownership, the area being assigned. */
    proposedValue?: string;
    rationale: string;
    sourceFileIds: string[];
    /** Untrusted; required for ownership and rejected for every other field. */
    ownerUserId?: string;
    actor: Actor;
    operation?: "add" | "resolve" | "remove";
    entryId?: string;
    supersedes?: string;
    expectedVersion?: number;
    /** Trusted callers only (the demo seed): record without a conflict check. */
    skipConflictCheck?: boolean;
  },
): Promise<Doc<"context_proposals"> & { deduplicated: boolean }> {
  const { workspaceId, actor, field } = args;
  const operation = args.operation ?? "add";
  const working = field === "constraint" || field === "open_question";
  if (
    (operation === "resolve" && field !== "open_question") ||
    (operation === "remove" && (!working || actor.type !== "human")) ||
    (operation !== "add" &&
      (!args.entryId || args.expectedVersion === undefined)) ||
    (operation === "add" && args.entryId !== undefined) ||
    (args.supersedes !== undefined &&
      (field !== "decision" || operation !== "add"))
  )
    throw new ConvexError({ code: "INVALID_INPUT" });
  let proposedValue = (args.proposedValue ?? "").trim();
  if (operation === "add" && (!proposedValue || proposedValue.length > 10000))
    throw new ConvexError({ code: "INVALID_INPUT", field: "proposedValue" });
  let owner: { ownerUserId: Id<"users">; ownerArea: string } | undefined;
  if (field === "ownership") {
    const area = proposedValue;
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
  // A retried or repeated request returns the proposal it already made.
  const duplicate = await findDuplicateProposal(ctx, {
    workspaceId, actor, field,
    operation: operation === "add" ? undefined : operation,
    proposedValue: operation === "add" ? proposedValue : undefined,
    supersedes: args.supersedes,
    entryId: args.entryId,
    ownerUserId: owner?.ownerUserId,
  });
  if (duplicate) return { ...duplicate, deduplicated: true };
  const context = await ctx.db
    .query("structured_context")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  if (!context) throw new ConvexError({ code: "CONTEXT_NOT_INITIALIZED" });
  if (
    args.expectedVersion !== undefined &&
    args.expectedVersion !== context.revision
  )
    throw new ConvexError({
      code: "VERSION_CONFLICT",
      currentVersion: context.revision,
    });
  const normalized = normalizeContext(context);
  if (
    args.supersedes !== undefined &&
    !normalized.decisions.some(
      (e) => e.id === args.supersedes && (!e.status || e.status === "active"),
    )
  )
    throw new ConvexError({ code: "INVALID_INPUT", field: "supersedes" });
  const targetKey = field === "constraint" ? "constraints" : "openQuestions";
  const existing = field === "goal" || field === "scope"
    ? context[field]
    : operation !== "add"
      ? normalized[targetKey].find((e) => e.id === args.entryId)
      : undefined;
  const sourceFileIds = await checkSourceFiles(
    ctx, workspaceId, args.sourceFileIds, existing?.sourceFileIds,
  );
  const conflict = operation === "add" && !args.skipConflictCheck
    ? await detectConflict(ctx, { workspaceId, field, proposedValue, supersedes: args.supersedes, context })
    : undefined;
  // Automatic workspaces apply only what no check holds for a person.
  const apply =
    (await appliesImmediately(ctx, workspaceId)) &&
    (!conflict || conflict.status === "clear");
  let appliedEntryId: string | undefined;
  const entryOperation =
    operation !== "add" ? { operation, entryId: args.entryId! } : undefined;
  if (entryOperation) {
    const target = normalized[targetKey].find((e) => e.id === args.entryId);
    if (!target || (operation === "resolve" && target.status === "resolved"))
      throw new ConvexError({ code: "INVALID_INPUT", field: "entryId" });
    if (apply)
      await applyEntryOperation(
        ctx, context, { field, ...entryOperation }, actor, Date.now(),
      );
    proposedValue = target.text;
  } else if (apply) {
    appliedEntryId = await applyApprovedProposal(
      ctx,
      {
        workspaceId, field, proposedValue, sourceFileIds, ...owner,
        supersedes: args.supersedes,
      },
      actor,
      Date.now(),
    );
  }
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
    sourceFileIds,
    contextRevision: context.revision + (apply ? 1 : 0),
    ...(args.supersedes !== undefined ? { supersedes: args.supersedes } : {}),
    ...(currentField !== undefined ? { baseValue: currentField } : {}),
    ...owner,
    ...entryOperation,
    ...(conflict ? { conflict } : {}),
    ...(conflict && conflict.items.length > 0 ? { hasConflict: true } : {}),
    ...(appliedEntryId !== undefined ? { appliedEntryId } : {}),
    status: apply ? "applied" : "pending",
    createdBy: actor,
    createdAt: now,
    updatedBy: actor,
    updatedAt: now,
    revision: 1,
  });
  await recordWorkspaceEvent(ctx, {
    workspaceId,
    kind: apply
      ? `context.${operation === "add" ? "recorded" : operation === "resolve" ? "resolved" : "removed"}`
      : "context.proposed",
    entityType: "context_proposal",
    entityId: proposalId,
    summary: `${apply ? "Applied" : "Proposed"} ${operation} to ${field.replaceAll("_", " ")}`,
    actor,
  });
  if (conflict?.status === "checking")
    await ctx.scheduler.runAfter(0, internal.conflicts.checkProposal, { proposalId });
  const proposal = await ctx.db.get(proposalId);
  if (!proposal) throw new ConvexError({ code: "PROPOSAL_NOT_FOUND" });
  for (const item of conflict?.items ?? [])
    if (item.kind === "competing") await markCompeting(ctx, proposal, item, conflict!.method);
  return { ...proposal, deduplicated: false };
}

export function toProposal(proposal: Doc<"context_proposals">) {
  return {
    id: proposal._id,
    workspaceId: proposal.workspaceId,
    field: proposal.field,
    operation: proposal.operation ?? ("add" as const),
    proposedValue: proposal.proposedValue,
    supersedes: proposal.supersedes ?? null,
    rationale: proposal.rationale,
    sourceFileIds: proposal.sourceFileIds,
    status: proposal.status,
    createdBy: proposal.createdBy,
    createdAt: proposal.createdAt,
    decidedBy: proposal.decidedBy ?? null,
    decidedAt: proposal.decidedAt ?? null,
    ownerUserId: proposal.ownerUserId ?? null,
    ownerArea: proposal.ownerArea ?? null,
    conflict: proposal.conflict ?? null,
    resolution: proposal.resolution ?? null,
    decisionNote: proposal.decisionNote ?? null,
    revision: proposal.revision,
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
export async function loadContext(ctx: ReadCtx, workspaceId: Id<"workspaces">) {
  const context = await ctx.db
    .query("structured_context")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  if (!context) throw new ConvexError({ code: "CONTEXT_NOT_INITIALIZED" });
  type ContextEntry = NonNullable<Doc<"structured_context">["goal"]>;
  const normalized = normalizeContext(context);
  const compact = (entry: ContextEntry) => ({
    text: entry.text,
    sourceFileIds: entry.sourceFileIds,
    updatedAt: entry.updatedAt,
    updatedBy: entry.updatedBy,
    id: entry.id ?? `${context._id}:scalar`,
    status: entry.status ?? ("active" as const),
    resolvedBy: entry.resolvedBy ?? null,
    resolvedAt: entry.resolvedAt ?? null,
    supersededBy: entry.supersededBy ?? null,
  });
  return {
    goal: context.goal ? compact(context.goal) : null,
    scope: context.scope ? compact(context.scope) : null,
    constraints: normalized.constraints.map(compact),
    decisions: normalized.decisions.map(compact),
    ownership: normalized.ownership.map((entry) => ({
      ...compact(entry),
      ownerUserId: entry.ownerUserId ?? null,
      ownerArea: entry.ownerArea ?? null,
    })),
    openQuestions: normalized.openQuestions.map(compact),
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
    .withIndex("by_workspace_and_deleted_at_and_updated_at", (q) =>
      q.eq("workspaceId", workspaceId).eq("deletedAt", undefined),
    )
    .order("desc")
    .take(SEARCH_SCAN_LIMIT);
  const byName = await ctx.db
    .query("files")
    .withSearchIndex("search_name", (q) =>
      q.search("name", query.trim()).eq("workspaceId", workspaceId).eq("deletedAt", undefined),
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
      snippet:
        at === -1
          ? snippet(content, 0, 0)
          : snippet(content, at, needle.length),
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
  const start = Math.max(
    0,
    Math.min(at - lead, content.length - SNIPPET_CHARS),
  );
  const end = start + SNIPPET_CHARS;
  const text = content.slice(start, end).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + text + (end < content.length ? "…" : "");
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---- Tasks ----------------------------------------------------------------

export type TaskStatus = Doc<"tasks">["status"];

const MAX_TASK_TITLE = 200;
const MAX_TASK_DESCRIPTION = 4000;

function memberName(user: Doc<"users"> | null): string {
  return user?.name ?? user?.email ?? "Workspace member";
}

export async function toTask(ctx: ReadCtx, task: Doc<"tasks">) {
  const owner = task.ownerId ? await ctx.db.get(task.ownerId) : null;
  return {
    id: task._id,
    title: task.title,
    description: task.description,
    status: task.status,
    ownerId: task.ownerId ?? null,
    ownerName: task.ownerId ? memberName(owner) : null,
    version: task.version,
    createdBy: task.createdBy,
    updatedBy: task.updatedBy,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt ?? null,
  };
}

/** Like getFileInWorkspace: missing, malformed and other-tenant ids are all TASK_NOT_FOUND. */
export async function getTaskInWorkspace(
  ctx: ReadCtx,
  taskId: string,
  workspaceId: Id<"workspaces">,
): Promise<Doc<"tasks">> {
  const id = ctx.db.normalizeId("tasks", taskId);
  const task = id ? await ctx.db.get(id) : null;
  if (!task || task.workspaceId !== workspaceId)
    throw new ConvexError({ code: "TASK_NOT_FOUND", taskId });
  return task;
}

/** Newest updatedAt first; status undefined lists every status. */
export async function listTasks(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
  status: TaskStatus | undefined,
  limit: number,
): Promise<Doc<"tasks">[]> {
  return status
    ? await ctx.db
        .query("tasks")
        .withIndex("by_workspace_and_status_and_updated_at", (q) =>
          q.eq("workspaceId", workspaceId).eq("status", status),
        )
        .order("desc")
        .take(limit)
    : await ctx.db
        .query("tasks")
        .withIndex("by_workspace_and_updated_at", (q) =>
          q.eq("workspaceId", workspaceId),
        )
        .order("desc")
        .take(limit);
}

/** The index order of by_workspace_and_updated_at, descending. */
function newestTaskFirst(a: Doc<"tasks">, b: Doc<"tasks">): number {
  return b.updatedAt - a.updatedAt || b._creationTime - a._creationTime;
}

/** Up to `limit` open and in-progress tasks, merged newest first. */
export async function listActiveTasks(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
  limit: number,
): Promise<Doc<"tasks">[]> {
  const open = await listTasks(ctx, workspaceId, "open", limit);
  const active = await listTasks(ctx, workspaceId, "in_progress", limit);
  return [...open, ...active].sort(newestTaskFirst).slice(0, limit);
}

function taskTitle(value: string): string {
  const title = value.trim();
  if (!title || title.length > MAX_TASK_TITLE)
    throw new ConvexError({ code: "INVALID_INPUT", field: "title" });
  return title;
}

function taskDescription(value: string): string {
  const description = value.trim();
  if (description.length > MAX_TASK_DESCRIPTION)
    throw new ConvexError({ code: "INVALID_INPUT", field: "description" });
  return description;
}

async function ownerDetails(ctx: ReadCtx, task: Doc<"tasks">) {
  const owner = task.ownerId ? await ctx.db.get(task.ownerId) : null;
  return {
    taskId: task._id,
    ownerUserId: task.ownerId ?? null,
    ownerName: task.ownerId ? memberName(owner) : null,
    status: task.status,
    currentVersion: task.version,
  };
}

function checkTaskVersion(task: Doc<"tasks">, expectedVersion: number) {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
    throw new ConvexError({ code: "INVALID_INPUT", field: "expectedVersion" });
  if (task.version !== expectedVersion)
    throw new ConvexError({
      code: "VERSION_CONFLICT",
      taskId: task._id,
      currentVersion: task.version,
      expectedVersion,
    });
}

/** Done tasks are final; an owned task changes only for its owner. */
async function checkTaskWritable(
  ctx: ReadCtx,
  task: Doc<"tasks">,
  userId: Id<"users">,
) {
  if (task.status === "done")
    throw new ConvexError({
      code: "TASK_DONE",
      taskId: task._id,
      currentVersion: task.version,
    });
  if (task.ownerId !== undefined && task.ownerId !== userId)
    throw new ConvexError({
      code: "TASK_NOT_OWNER",
      ...(await ownerDetails(ctx, task)),
    });
}

/** Patches version N+1 and records exactly one task.* event. */
async function commitTask(
  ctx: MutationCtx,
  task: Doc<"tasks">,
  fields: Partial<Pick<Doc<"tasks">, "title" | "description" | "status" | "ownerId" | "completedAt">>,
  kind: "task.claimed" | "task.updated" | "task.completed",
  verb: string,
  actor: Actor,
): Promise<Doc<"tasks">> {
  const version = task.version + 1;
  await ctx.db.patch(task._id, {
    ...fields,
    version,
    revision: version,
    updatedBy: actor,
    updatedAt: Date.now(),
  });
  await recordWorkspaceEvent(ctx, {
    workspaceId: task.workspaceId,
    kind,
    entityType: "task",
    entityId: task._id,
    summary: `${verb} task: ${truncate(fields.title ?? task.title, 80)}`,
    actor,
  });
  return (await ctx.db.get(task._id))!;
}

export async function createTaskCore(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    title: string;
    description: string;
    actor: Actor;
  },
): Promise<Doc<"tasks">> {
  const title = taskTitle(args.title);
  const now = Date.now();
  const taskId = await ctx.db.insert("tasks", {
    workspaceId: args.workspaceId,
    title,
    description: taskDescription(args.description),
    status: "open",
    version: 1,
    createdBy: args.actor,
    updatedBy: args.actor,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  await recordWorkspaceEvent(ctx, {
    workspaceId: args.workspaceId,
    kind: "task.created",
    entityType: "task",
    entityId: taskId,
    summary: `Created task: ${truncate(title, 80)}`,
    actor: args.actor,
  });
  return (await ctx.db.get(taskId))!;
}

/**
 * Claims an open, unowned task for `userId`. The read-check-write runs in one
 * mutation, and Convex mutations are serializable (OCC): of two concurrent
 * claims, the second retries against the first's write and fails with
 * TASK_ALREADY_CLAIMED, so both can never succeed. Re-claiming a task the
 * person already owns is a no-op that returns it unchanged.
 */
export async function claimTaskCore(
  ctx: MutationCtx,
  args: {
    task: Doc<"tasks">;
    expectedVersion: number;
    userId: Id<"users">;
    actor: Actor;
  },
): Promise<Doc<"tasks">> {
  const { task } = args;
  if (task.status === "done")
    throw new ConvexError({
      code: "TASK_DONE",
      taskId: task._id,
      currentVersion: task.version,
    });
  if (task.status === "in_progress" && task.ownerId === args.userId) return task;
  if (task.ownerId !== undefined || task.status !== "open")
    throw new ConvexError({
      code: "TASK_ALREADY_CLAIMED",
      ...(await ownerDetails(ctx, task)),
    });
  checkTaskVersion(task, args.expectedVersion);
  return await commitTask(
    ctx,
    task,
    { ownerId: args.userId, status: "in_progress" },
    "task.claimed",
    "Claimed",
    args.actor,
  );
}

/**
 * Edits title, description or status. Status "open" releases the claim;
 * "in_progress" on an unowned task makes the caller its owner, so an
 * in-progress task always has one.
 */
export async function updateTaskCore(
  ctx: MutationCtx,
  args: {
    task: Doc<"tasks">;
    expectedVersion: number;
    userId: Id<"users">;
    title?: string;
    description?: string;
    status?: TaskStatus;
    actor: Actor;
  },
): Promise<Doc<"tasks">> {
  const { task } = args;
  if (args.status === "done")
    throw new ConvexError({ code: "INVALID_INPUT", field: "status" });
  const title = args.title === undefined ? undefined : taskTitle(args.title);
  const description =
    args.description === undefined ? undefined : taskDescription(args.description);
  await checkTaskWritable(ctx, task, args.userId);
  checkTaskVersion(task, args.expectedVersion);
  if (
    (title === undefined || title === task.title) &&
    (description === undefined || description === task.description) &&
    (args.status === undefined || args.status === task.status)
  )
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "The update changes nothing.",
    });
  // Moving an unowned task to in progress assigns its owner: that is a claim.
  const claims = args.status === "in_progress" && task.ownerId === undefined;
  return await commitTask(
    ctx,
    task,
    {
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(args.status === "open"
        ? { status: "open" as const, ownerId: undefined }
        : {}),
      ...(args.status === "in_progress"
        ? { status: "in_progress" as const, ownerId: task.ownerId ?? args.userId }
        : {}),
    },
    claims ? "task.claimed" : "task.updated",
    claims ? "Claimed" : "Updated",
    args.actor,
  );
}

/** Any member may complete an unowned task; they become its owner. */
export async function completeTaskCore(
  ctx: MutationCtx,
  args: {
    task: Doc<"tasks">;
    expectedVersion: number;
    userId: Id<"users">;
    actor: Actor;
  },
): Promise<Doc<"tasks">> {
  const { task } = args;
  await checkTaskWritable(ctx, task, args.userId);
  checkTaskVersion(task, args.expectedVersion);
  return await commitTask(
    ctx,
    task,
    {
      status: "done" as const,
      ownerId: task.ownerId ?? args.userId,
      completedAt: Date.now(),
    },
    "task.completed",
    "Completed",
    args.actor,
  );
}

export const SYNC_LIMIT = 50;
const SYNC_WORK_LIMIT = 20;
const SYNC_RESOLVED_LIMIT = 5;

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
 * Snapshot (sinceSeq undefined): latest SYNC_LIMIT events, newest files and
 * active tasks. Incremental: events with seq > sinceSeq, oldest first, and the
 * files and tasks they touched. A sinceSeq past the newest event is
 * INVALID_CURSOR.
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
      .withIndex("by_workspace_and_deleted_at_and_updated_at", (q) =>
        q.eq("workspaceId", workspaceId).eq("deletedAt", undefined),
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
    const movedFolderIds = new Set<string>();
    for (const event of events) {
      if (event.entityType === "file") fileIds.add(event.entityId);
      // A renamed or moved folder changes the path of every file below it.
      else if (event.kind === "folder.renamed" || event.kind === "folder.moved")
        movedFolderIds.add(event.entityId);
    }
    changedFiles = [];
    for (const raw of fileIds) {
      const id = ctx.db.normalizeId("files", raw);
      const file = id ? await ctx.db.get(id) : null;
      if (file && file.deletedAt === undefined && file.workspaceId === workspaceId) changedFiles.push(file);
    }
    const seen = new Set(changedFiles.map((f) => f._id));
    for (const raw of movedFolderIds) {
      if (changedFiles.length > SYNC_LIMIT) break;
      const id = ctx.db.normalizeId("folders", raw);
      const folder = id ? await ctx.db.get(id) : null;
      if (!folder || folder.deletedAt !== undefined || folder.workspaceId !== workspaceId) continue;
      for (const file of await listSubtreeFiles(ctx, folder, SYNC_LIMIT + 1)) {
        if (seen.has(file._id)) continue;
        seen.add(file._id);
        changedFiles.push(file);
      }
    }
    changedFiles.sort((a, b) => b.updatedAt - a.updatedAt);
    filesTruncated = changedFiles.length > SYNC_LIMIT;
    changedFiles = changedFiles.slice(0, SYNC_LIMIT);
  }
  let work: Doc<"published_work">[];
  if (sinceSeq === undefined) {
    work = await ctx.db
      .query("published_work")
      .withIndex("by_workspace_and_created", (q) =>
        q.eq("workspaceId", workspaceId),
      )
      .order("desc")
      .take(SYNC_WORK_LIMIT + 1);
  } else {
    // Use event sequence numbers, not timestamps: writes can share a millisecond.
    // Only return work acknowledged by this page, so continuation syncs do not repeat it.
    const publications = await ctx.db
      .query("workspace_events")
      .withIndex("by_workspace_and_kind_and_seq", (q) =>
        q
          .eq("workspaceId", workspaceId)
          .eq("kind", "work.published")
          .gt("seq", sinceSeq)
          .lte("seq", cursorSeq),
      )
      .order("desc")
      .take(SYNC_WORK_LIMIT + 1);
    work = [];
    for (const event of publications) {
      const id = ctx.db.normalizeId("published_work", event.entityId);
      const row = id ? await ctx.db.get(id) : null;
      if (row && row.workspaceId === workspaceId) work.push(row);
    }
  }
  let tasks: Doc<"tasks">[];
  let tasksTruncated: boolean;
  if (sinceSeq === undefined) {
    // Active tasks only: open and in progress, merged newest first.
    const merged = await listActiveTasks(ctx, workspaceId, SYNC_LIMIT + 1);
    tasksTruncated = merged.length > SYNC_LIMIT;
    tasks = merged.slice(0, SYNC_LIMIT);
  } else {
    // Every task this event page touched, in any status, like changedFiles.
    const taskIds = new Set<string>();
    for (const event of events)
      if (event.entityType === "task") taskIds.add(event.entityId);
    tasks = [];
    for (const raw of taskIds) {
      const id = ctx.db.normalizeId("tasks", raw);
      const task = id ? await ctx.db.get(id) : null;
      if (task && task.workspaceId === workspaceId) tasks.push(task);
    }
    tasks.sort(newestTaskFirst);
    tasksTruncated = false;
  }
  const pending = await listProposals(ctx, workspaceId, "pending", SYNC_LIMIT);
  // Newest resolutions first: the snapshot's latest few, or only those this
  // event page acknowledges (like recentWork).
  const resolutions = await ctx.db
    .query("workspace_events")
    .withIndex("by_workspace_and_kind_and_seq", (q) => {
      const kind = q.eq("workspaceId", workspaceId).eq("kind", "context.conflict_resolved");
      return sinceSeq === undefined ? kind : kind.gt("seq", sinceSeq).lte("seq", cursorSeq);
    })
    .order("desc")
    .take(sinceSeq === undefined ? SYNC_RESOLVED_LIMIT : SYNC_LIMIT);
  const resolved: Doc<"context_proposals">[] = [];
  for (const event of resolutions) {
    const id = ctx.db.normalizeId("context_proposals", event.entityId);
    const row = id ? await ctx.db.get(id) : null;
    if (row && row.workspaceId === workspaceId && row.decidedAt !== undefined)
      resolved.push(row);
  }
  const context = await loadContext(ctx, workspaceId);
  return {
    workspace: { id: workspace._id, name: workspace.name },
    context,
    resolvedConflicts: resolved.map((p) => toResolvedConflict(p, context)),
    pendingProposals: pending.map((p) => ({
      id: p._id,
      field: p.field,
      operation: p.operation ?? ("add" as const),
      rationale: p.rationale,
      proposedValue: p.proposedValue,
      supersedes: p.supersedes ?? null,
      status: "pending" as const,
      createdBy: p.createdBy,
      createdAt: p.createdAt,
      conflict: p.conflict ?? null,
    })),
    changedFiles: changedFiles.map(toFileMetadata),
    filesTruncated,
    recentWork: work.slice(0, SYNC_WORK_LIMIT).map(toPublishedWork),
    workTruncated: work.length > SYNC_WORK_LIMIT,
    tasks: await Promise.all(tasks.map((task) => toTask(ctx, task))),
    tasksTruncated,
    events: events.map(toEvent),
    eventsTruncated,
    headSeq,
    cursorSeq,
  };
}

export async function applyApprovedProposal(
  ctx: MutationCtx,
  proposal: Pick<
    Doc<"context_proposals">,
    | "workspaceId"
    | "field"
    | "proposedValue"
    | "sourceFileIds"
    | "ownerUserId"
    | "ownerArea"
    | "supersedes"
    | "operation"
    | "entryId"
  >,
  actor: Actor,
  now: number,
  entryIndex?: number,
  /** Active decisions and constraints the new entry supersedes (a resolution). */
  supersedeIds: readonly string[] = [],
): Promise<string | undefined> {
  const stored = await ctx.db
    .query("structured_context")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", proposal.workspaceId))
    .unique();
  if (!stored) throw new ConvexError({ code: "CONTEXT_NOT_INITIALIZED" });
  if (proposal.operation) {
    if (!proposal.entryId || entryTargetMissing(stored, proposal))
      throw new ConvexError({ code: "INVALID_INPUT", field: "entryId" });
    await applyEntryOperation(
      ctx,
      stored,
      {
        field: proposal.field,
        operation: proposal.operation,
        entryId: proposal.entryId,
      },
      actor,
      now,
    );
    return undefined;
  }
  const context = normalizeContext(stored);
  const value = {
    id: crypto.randomUUID(),
    status: "active" as const,
    text: proposal.proposedValue,
    sourceFileIds: proposal.sourceFileIds,
    updatedBy: actor,
    updatedAt: now,
  };
  const supersede = <T extends { id: string; status?: string }>(entries: T[]) =>
    entries.map((e) =>
      supersedeIds.includes(e.id) && isActive(e)
        ? { ...e, status: "superseded" as const, supersededBy: value.id }
        : e,
    );
  const next = {
    constraints: supersede(context.constraints),
    decisions: supersede(context.decisions),
    ownership: context.ownership,
    openQuestions: context.openQuestions,
    revision: context.revision + 1,
    updatedAt: now,
    updatedBy: actor,
  };
  const put = <T extends { id?: string }>(entries: T[], entry: T) =>
    entryIndex === undefined
      ? [...entries, entry]
      : entries.map((old, index) =>
          index === entryIndex ? { ...entry, id: old.id } : old,
        );
  switch (proposal.field) {
    case "goal":
      await ctx.db.patch(context._id, { ...next, goal: value });
      break;
    case "scope":
      await ctx.db.patch(context._id, { ...next, scope: value });
      break;
    case "constraint":
      await ctx.db.patch(context._id, {
        ...next,
        constraints: put(next.constraints, value),
      });
      break;
    case "decision": {
      const old = proposal.supersedes
        ? context.decisions.find((e) => e.id === proposal.supersedes)
        : null;
      if (
        proposal.supersedes &&
        (!old || (old.status && old.status !== "active"))
      )
        throw new ConvexError({ code: "INVALID_INPUT", field: "supersedes" });
      const decisions = next.decisions.map((e) =>
        e.id === proposal.supersedes
          ? { ...e, status: "superseded" as const, supersededBy: value.id }
          : e,
      );
      await ctx.db.patch(context._id, {
        ...next,
        decisions: put(decisions, value),
      });
      break;
    }
    case "ownership": {
      // Re-checked on approval: the owner may have left since the proposal.
      // Legacy free-text proposals have no owner to check and can't be approved.
      if (!proposal.ownerUserId || !proposal.ownerArea)
        throw new ConvexError({ code: "INVALID_INPUT", field: "ownerUserId" });
      const owner = await requireOwnerMember(
        ctx,
        proposal.workspaceId,
        proposal.ownerUserId,
      );
      // One owner per area: approval replaces the owner of an equal area.
      const area = nameKey(proposal.ownerArea);
      await ctx.db.patch(context._id, {
        ...next,
        ownership: [
          ...context.ownership.filter(
            (entry, index) =>
              index !== entryIndex &&
              (entry.ownerArea === undefined ||
                nameKey(entry.ownerArea) !== area),
          ),
          {
            ...value,
            id:
              entryIndex === undefined
                ? value.id
                : context.ownership[entryIndex]!.id,
            text: ownershipText(proposal.ownerArea, owner),
            ownerUserId: owner._id,
            ownerArea: proposal.ownerArea,
          },
        ],
      });
      break;
    }
    case "open_question":
      await ctx.db.patch(context._id, {
        ...next,
        openQuestions: put(context.openQuestions, value),
      });
      break;
  }
  return entryIndex === undefined ? value.id : undefined;
}
