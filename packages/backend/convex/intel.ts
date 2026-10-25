// The Haiku context manager (docs/context-intelligence.md, processing rules).
// processWorkspace claims the workspace (a lease), loads one bounded batch of
// pending activity_events plus the current derived and project context, and
// asks the model (or runs the heuristic without a key): one call for the
// activity, and one digest call per text document the batch touched, which
// reads the whole document. Results are validated deterministically
// (lib/intel.ts) and applied in one mutation guarded by entriesRevision; then
// any section over its size threshold is compacted the same way. Goal,
// decision and ownership findings are recorded in project context
// (structured_context) at once, through the same core as a person's edit.
import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { recordWorkspaceEvent } from "./lib/auth";
import { shortHash } from "./lib/activityLog";
import {
  COMPACT_RESPONSE_SCHEMA,
  COMPACT_SYSTEM_PROMPT,
  COMPACT_THRESHOLDS,
  DIGEST_RESPONSE_SCHEMA,
  DIGEST_SYSTEM_PROMPT,
  DOC_EVENT_TYPES,
  MIN_CHANGE_CONFIDENCE,
  DOC_KEY_PREFIX,
  IntelParseError,
  LIVE_STATUSES,
  MAX_COMPACT_INPUT,
  MAX_EVENTS,
  MAX_ENTRIES,
  MAX_EVIDENCE_IDS,
  RESPONSE_SCHEMA,
  SYSTEM_PROMPT,
  compactMessage,
  digestMessage,
  docKey,
  documentText,
  evidenceRank,
  extractJson,
  heuristicDigest,
  heuristicOutput,
  systemBlocks,
  userMessage,
  validateCompaction,
  validateDigest,
  validateIntelOutput,
  withDeterministic,
  type Category,
  type CompactSection,
  type DocumentInput,
  type IntelResult,
} from "./lib/intel";
import {
  batchWindowMs,
  contextModel,
  enqueueBackfillPage,
  INTEL_ACTOR,
  intelDisabled,
} from "./lib/intelQueue";
import { changeContextCore, loadContext, normalizeContext } from "./lib/ops";
import { nameKey } from "./lib/names";
import schema from "./schema";

declare const process: { env: Record<string, string | undefined> };

type ReadCtx = QueryCtx | MutationCtx;

// Long enough for a batch of digests plus compaction (CONCURRENCY at a time).
const LEASE_MS = 6 * 60 * 1000;
const TIMEOUT_MS = 25_000;
// A digest sends a whole document (up to ~24 KB).
const DIGEST_TIMEOUT_MS = 45_000;
const MAX_TOKENS = 8192;
const TRUNCATED = "output truncated";
const MIN_RETRY_EVENTS = 5;
/** Documents one batch reads; later documents wait for the next batch (never dropped). */
const MAX_DOCUMENTS = 12;
/** Model calls in flight at once within a run. */
const CONCURRENCY = 4;
/** Project context changes one run records across all its calls. */
const MAX_RUN_CHANGES = 12;
const COMPACT_SCAN = 120;
const MAX_CONNECTIONS = 50;
const MAX_MEMBERS = 100;
const MAX_FAILURES = 5;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 10 * 60 * 1000;

const entryFields = schema.tables.context_entries.validator.fields;

const batchValidator = v.object({
  runId: v.id("context_intel_runs"),
  method: v.union(v.literal("llm"), v.literal("heuristic")),
  model: v.optional(v.string()),
  entriesRevision: v.number(),
  events: v.array(
    v.object({
      id: v.string(),
      createdAt: v.number(),
      source: v.string(),
      type: v.string(),
      tool: v.optional(v.string()),
      outcome: v.union(v.literal("ok"), v.literal("conflict"), v.literal("error")),
      errorCode: v.optional(v.string()),
      summary: v.string(),
      payload: v.optional(v.string()),
      agentConnectionId: v.optional(v.string()),
      actorType: v.union(v.literal("human"), v.literal("agent"), v.literal("system")),
      actorLabel: v.string(),
      fileIds: v.array(v.string()),
    }),
  ),
  entries: v.array(
    v.object({
      key: v.string(),
      category: entryFields.category,
      title: v.string(),
      content: v.string(),
      status: entryFields.status,
      evidence: entryFields.evidence,
      confidence: v.number(),
      evidenceEventIds: v.array(v.string()),
      severity: entryFields.severity,
    }),
  ),
  context: v.object({
    goal: v.union(v.string(), v.null()),
    scope: v.union(v.string(), v.null()),
    decisions: v.array(v.object({ id: v.string(), text: v.string() })),
    constraints: v.array(v.object({ id: v.string(), text: v.string() })),
    ownership: v.array(v.object({ area: v.string(), ownerUserId: v.union(v.string(), v.null()) })),
  }),
  members: v.array(v.object({ id: v.string(), name: v.string() })),
  connections: v.array(v.object({ id: v.string(), label: v.string(), client: v.string() })),
  files: v.array(v.object({ id: v.string(), name: v.string() })),
  documents: v.array(
    v.object({
      fileId: v.string(),
      name: v.string(),
      path: v.string(),
      version: v.number(),
      author: v.string(),
      authorType: v.union(v.literal("human"), v.literal("agent"), v.literal("system")),
      content: v.string(),
      truncated: v.boolean(),
      sourceHash: v.string(),
      eventIds: v.array(v.string()),
      previous: v.union(v.null(), v.object({ content: v.string(), sourceHash: v.optional(v.string()) })),
    }),
  ),
});
type Batch = Infer<typeof batchValidator>;

const entryOpValidator = v.object({
  op: v.union(
    v.literal("upsert"),
    v.literal("supersede"),
    v.literal("complete"),
    v.literal("reopen"),
    v.literal("resolve"),
    v.literal("retract"),
  ),
  key: v.string(),
  category: entryFields.category,
  title: v.string(),
  content: v.string(),
  status: entryFields.status,
  evidence: entryFields.evidence,
  confidence: v.number(),
  evidenceEventIds: v.array(v.id("activity_events")),
  agentConnectionIds: v.array(v.id("agent_connections")),
  fileIds: v.array(v.id("files")),
  supersededBy: v.optional(v.string()),
  severity: entryFields.severity,
  reason: v.string(),
  sourceHash: v.optional(v.string()),
});
type EntryOpArg = Infer<typeof entryOpValidator>;

const changeOpValidator = v.object({
  field: v.union(v.literal("goal"), v.literal("decision"), v.literal("ownership")),
  text: v.string(),
  ownerUserId: v.optional(v.string()),
  confidence: v.number(),
  evidenceEventIds: v.array(v.id("activity_events")),
  fileIds: v.array(v.id("files")),
  supersedes: v.optional(v.string()),
  key: v.string(),
});

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
const normalize = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

async function getState(ctx: ReadCtx, workspaceId: Id<"workspaces">) {
  return await ctx.db
    .query("context_intel_state")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

/** Patches the scheduler row, creating it first if the workspace has none. */
async function patchState(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  fields: Partial<Omit<Doc<"context_intel_state">, "_id" | "_creationTime" | "workspaceId">>,
) {
  const state = await getState(ctx, workspaceId);
  const now = Date.now();
  if (state) await ctx.db.patch(state._id, { ...fields, updatedAt: now });
  else
    await ctx.db.insert("context_intel_state", {
      workspaceId,
      status: "idle",
      consecutiveFailures: 0,
      entriesRevision: 0,
      ...fields,
      updatedAt: now,
    });
}

async function pendingEvents(ctx: ReadCtx, workspaceId: Id<"workspaces">, limit: number) {
  return await ctx.db
    .query("activity_events")
    .withIndex("by_workspace_and_intel_status_and_created", (q) =>
      q.eq("workspaceId", workspaceId).eq("intelStatus", "pending"),
    )
    .take(limit);
}

async function getEntry(ctx: ReadCtx, workspaceId: Id<"workspaces">, key: string) {
  return await ctx.db
    .query("context_entries")
    .withIndex("by_workspace_and_key", (q) => q.eq("workspaceId", workspaceId).eq("key", key))
    .first();
}

/** Everything the model sees for these events, with ids checked against the workspace. */
async function loadBatch(
  ctx: ReadCtx,
  args: {
    workspaceId: Id<"workspaces">;
    runId: Id<"context_intel_runs">;
    method: "llm" | "heuristic";
    model?: string;
    entriesRevision: number;
    events: Doc<"activity_events">[];
  },
): Promise<Batch> {
  const { workspaceId } = args;
  const files = new Map<Id<"files">, Doc<"files">>();
  const workspaceFile = async (raw: string) => {
    const id = ctx.db.normalizeId("files", raw);
    if (!id) return null;
    if (files.has(id)) return files.get(id)!;
    const file = await ctx.db.get(id);
    if (!file || file.workspaceId !== workspaceId) return null;
    files.set(id, file);
    return file;
  };
  const events: Batch["events"] = [];
  // Text documents to read, newest touch last: fileId → this batch's events for it.
  const touched = new Map<Id<"files">, string[]>();
  for (const e of args.events) {
    const fileIds: string[] = [];
    for (const r of e.resources) {
      if (r.type !== "file") continue;
      const file = await workspaceFile(r.id);
      if (file) fileIds.push(file._id);
    }
    if (DOC_EVENT_TYPES.has(e.type) && fileIds.length > 0) {
      const id = fileIds[0] as Id<"files">;
      const list = touched.get(id) ?? [];
      touched.delete(id);
      touched.set(id, [...list, e._id]);
    }
    events.push({
      id: e._id,
      createdAt: e.createdAt,
      source: e.source,
      type: e.type,
      ...(e.tool !== undefined ? { tool: e.tool } : {}),
      outcome: e.outcome,
      ...(e.errorCode !== undefined ? { errorCode: e.errorCode } : {}),
      summary: e.summary,
      ...(e.payload !== undefined ? { payload: e.payload } : {}),
      ...(e.agentConnectionId !== undefined ? { agentConnectionId: e.agentConnectionId } : {}),
      actorType: e.actor.type,
      actorLabel: e.actor.label,
      fileIds,
    });
  }

  // Each touched text document once, at its current content (deduped by file).
  const documents: Batch["documents"] = [];
  for (const [fileId, eventIds] of touched) {
    const file = files.get(fileId)!;
    // Deleted and binary files have nothing to read.
    if (file.deletedAt !== undefined || file.storageId !== undefined || typeof file.content !== "string") continue;
    const sourceHash = shortHash(file.content);
    const previous = await getEntry(ctx, workspaceId, docKey(fileId));
    // Unchanged since the last digest: no model call.
    if (previous?.sourceHash === sourceHash) continue;
    documents.push({
      fileId,
      name: file.name,
      path: await filePath(ctx, file),
      version: file.version,
      author: file.updatedBy.label,
      authorType: file.updatedBy.type,
      ...documentText(file.content),
      sourceHash,
      eventIds,
      previous: previous
        ? { content: previous.content, ...(previous.sourceHash !== undefined ? { sourceHash: previous.sourceHash } : {}) }
        : null,
    });
  }

  const entries = (
    await ctx.db
      .query("context_entries")
      .withIndex("by_workspace_and_updated_at", (q) => q.eq("workspaceId", workspaceId))
      .order("desc")
      .take(MAX_ENTRIES * 2)
  )
    .filter((e) => e.status === "active")
    .slice(0, MAX_ENTRIES)
    .map((e) => ({
      key: e.key,
      category: e.category,
      title: e.title,
      content: e.content,
      status: e.status,
      evidence: e.evidence,
      confidence: e.confidence,
      evidenceEventIds: e.evidenceEventIds,
      ...(e.severity !== undefined ? { severity: e.severity } : {}),
    }));

  let context: Batch["context"] = { goal: null, scope: null, decisions: [], constraints: [], ownership: [] };
  try {
    const loaded = await loadContext(ctx, workspaceId);
    const active = (list: { id: string; text: string; status: string }[]) =>
      list.filter((e) => e.status === "active").map((e) => ({ id: e.id, text: e.text }));
    context = {
      goal: loaded.goal?.text ?? null,
      scope: loaded.scope?.text ?? null,
      decisions: active(loaded.decisions),
      constraints: active(loaded.constraints),
      ownership: loaded.ownership
        .filter((o) => o.status === "active")
        .map((o) => ({ area: o.ownerArea ?? o.text, ownerUserId: o.ownerUserId })),
    };
  } catch {
    // CONTEXT_NOT_INITIALIZED: no project context yet.
  }
  // Who an ownership change can name: ids and names only, never emails.
  const members: Batch["members"] = [];
  for (const m of await ctx.db
    .query("workspace_members")
    .withIndex("by_workspace_and_user", (q) => q.eq("workspaceId", workspaceId))
    .take(MAX_MEMBERS)) {
    const user = await ctx.db.get(m.userId);
    if (user) members.push({ id: user._id, name: user.name?.trim() || "Workspace member" });
  }

  const connectionDocs = new Map<string, Doc<"agent_connections">>();
  for (const c of await ctx.db
    .query("agent_connections")
    .withIndex("by_workspace_and_revoked_at", (q) =>
      q.eq("workspaceId", workspaceId).eq("revokedAt", undefined),
    )
    .take(MAX_CONNECTIONS))
    connectionDocs.set(c._id, c);
  // Revoked since, but still the author of an event in this batch.
  for (const e of args.events) {
    if (!e.agentConnectionId || connectionDocs.has(e.agentConnectionId)) continue;
    const c = await ctx.db.get(e.agentConnectionId);
    if (c && c.workspaceId === workspaceId) connectionDocs.set(c._id, c);
  }
  const connections: Batch["connections"] = [];
  for (const c of connectionDocs.values()) {
    const user = await ctx.db.get(c.userId);
    connections.push({
      id: c._id,
      label: c.displayName ?? `${c.client} (${user?.name ?? user?.email ?? "member"})`,
      client: c.client,
    });
  }
  // An event from a connection outside the workspace can't name it.
  for (const e of events)
    if (e.agentConnectionId && !connectionDocs.has(e.agentConnectionId)) delete e.agentConnectionId;

  return {
    runId: args.runId,
    method: args.method,
    ...(args.model !== undefined ? { model: args.model } : {}),
    entriesRevision: args.entriesRevision,
    events,
    entries,
    context,
    members,
    connections,
    files: [...files.values()].map((f) => ({ id: f._id, name: f.name })),
    documents,
  };
}

/** "folder/sub/name.md": the file's folders, at most 10 deep. */
async function filePath(ctx: ReadCtx, file: Doc<"files">) {
  const parts = [file.name];
  let parentId = file.parentId;
  for (let depth = 0; parentId && depth < 10; depth++) {
    const folder = await ctx.db.get(parentId);
    if (!folder || folder.workspaceId !== file.workspaceId) break;
    parts.unshift(folder.name);
    parentId = folder.parentId;
  }
  return parts.join("/");
}

/**
 * The pending events up to the first one that would add a document past
 * MAX_DOCUMENTS, so one run never makes an unbounded number of digest calls.
 * The rest stay pending for the next batch.
 */
function capDocuments(events: Doc<"activity_events">[]) {
  const docs = new Set<string>();
  const out: Doc<"activity_events">[] = [];
  for (const e of events) {
    const fileId = DOC_EVENT_TYPES.has(e.type) ? e.resources.find((r) => r.type === "file")?.id : undefined;
    if (fileId !== undefined && !docs.has(fileId)) {
      if (docs.size >= MAX_DOCUMENTS && out.length > 0) break;
      docs.add(fileId);
    }
    out.push(e);
  }
  return out;
}

/**
 * Takes the lease (a live one held by another run wins; an expired one is
 * taken over), queues the one-time document backfill on a workspace's first
 * run, and returns the oldest pending events as one batch. With
 * nothing pending, records a skipped run and goes idle.
 */
export const claimBatch = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.null(), batchValidator),
  handler: async (ctx, { workspaceId }) => {
    const now = Date.now();
    const state = await getState(ctx, workspaceId);
    if (state?.status === "running" && (state.leaseExpiresAt ?? 0) > now) return null;
    // No live lease here, so a last run still marked running crashed, even if
    // requestIntelRun has since moved the state to scheduled.
    const last = state?.lastRunId ? await ctx.db.get(state.lastRunId) : null;
    if (last?.status === "running")
      await ctx.db.patch(last._id, { status: "failed", error: "lease expired", finishedAt: now });
    // The first run for a workspace also reads the documents it already has:
    // one file.backfill event per live text file, claimed below like any
    // other. backfilledAt is set when the backfill is queued, so later runs
    // don't queue it again while continuation pages are still being written.
    if (state?.backfilledAt === undefined) {
      await patchState(ctx, workspaceId, { backfilledAt: now });
      await enqueueBackfillPage(ctx, workspaceId, null, { requestRun: false });
    }
    // A reply cut off at max_tokens: retry with half the events.
    const limit =
      last?.status === "failed" && last.error?.startsWith(TRUNCATED)
        ? Math.max(MIN_RETRY_EVENTS, Math.floor(last.eventIds.length / 2))
        : MAX_EVENTS;
    const events = capDocuments(await pendingEvents(ctx, workspaceId, limit));
    const method = process.env.ANTHROPIC_API_KEY ? ("llm" as const) : ("heuristic" as const);
    const model = method === "llm" ? contextModel() : undefined;
    const runId = await ctx.db.insert("context_intel_runs", {
      workspaceId,
      status: events.length > 0 ? "running" : "skipped",
      method,
      ...(model !== undefined ? { model } : {}),
      eventIds: events.map((e) => e._id),
      attempt: (state?.consecutiveFailures ?? 0) + 1,
      ...(events.length === 0 ? { summary: "No pending events", finishedAt: now } : {}),
      created: 0,
      updated: 0,
      contextChanges: 0,
      startedAt: now,
    });
    if (events.length === 0) {
      // Nothing new to read, but goal and decision findings the model only
      // recorded as entries still reach project context.
      const promoted = await promoteFindings(ctx, workspaceId, [], PROMOTE_PER_RUN);
      if (promoted > 0) await ctx.db.patch(runId, { contextChanges: promoted });
      await patchState(ctx, workspaceId, {
        status: "idle",
        scheduledFor: undefined,
        leaseExpiresAt: undefined,
      });
      return null;
    }
    await patchState(ctx, workspaceId, {
      status: "running",
      scheduledFor: undefined,
      leaseExpiresAt: now + LEASE_MS,
      lastRunId: runId,
    });
    return await loadBatch(ctx, {
      workspaceId,
      runId,
      method,
      model,
      entriesRevision: state?.entriesRevision ?? 0,
      events,
    });
  },
});

/** The run's events that are still pending, against fresh context (after a stale apply). */
export const reloadBatch = internalQuery({
  args: { workspaceId: v.id("workspaces"), runId: v.id("context_intel_runs") },
  returns: v.union(v.null(), batchValidator),
  handler: async (ctx, { workspaceId, runId }) => {
    const run = await ctx.db.get(runId);
    const state = await getState(ctx, workspaceId);
    if (!run || run.status !== "running" || state?.lastRunId !== runId) return null;
    const events: Doc<"activity_events">[] = [];
    for (const id of run.eventIds) {
      const e = await ctx.db.get(id);
      if (e?.intelStatus === "pending") events.push(e);
    }
    if (events.length === 0) return null;
    return await loadBatch(ctx, {
      workspaceId,
      runId,
      method: run.method,
      model: run.model,
      entriesRevision: state.entriesRevision,
      events,
    });
  },
});

/** What changed between an entry and the op applied to it, or null for nothing. */
function changeKind(
  existing: Doc<"context_entries">,
  next: Pick<Doc<"context_entries">, "status">,
): Doc<"context_entry_revisions">["change"] {
  if (next.status === existing.status) return "updated";
  if (next.status === "superseded") return "superseded";
  if (next.status === "active") return "reopened";
  return "status_changed";
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Upserts one entry by key. Identical content writes nothing (a re-run is
 * idempotent). An entry a person confirmed or corrected only changes on
 * stronger evidence.
 */
async function applyEntry(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  op: EntryOpArg,
  run: { runId: Id<"context_intel_runs">; model?: string; now: number },
): Promise<"created" | "updated" | "protected" | null> {
  const existing = await getEntry(ctx, workspaceId, op.key);
  const { now } = run;
  const snapshot = {
    category: existing?.category ?? op.category,
    title: op.title,
    content: op.content,
    status: op.status,
    evidence: op.evidence,
    confidence: op.confidence,
  };
  if (!existing) {
    const entryId = await ctx.db.insert("context_entries", {
      workspaceId,
      key: op.key,
      ...snapshot,
      evidenceEventIds: op.evidenceEventIds.slice(0, MAX_EVIDENCE_IDS),
      agentConnectionIds: op.agentConnectionIds,
      fileIds: op.fileIds,
      ...(op.severity !== undefined ? { severity: op.severity } : {}),
      ...(op.status === "superseded" && op.supersededBy !== undefined
        ? { supersededBy: op.supersededBy }
        : {}),
      ...(op.sourceHash !== undefined ? { sourceHash: op.sourceHash } : {}),
      ...(run.model !== undefined ? { model: run.model } : {}),
      lastRunId: run.runId,
      createdBy: INTEL_ACTOR,
      updatedBy: INTEL_ACTOR,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("context_entry_revisions", {
      workspaceId,
      entryId,
      key: op.key,
      revision: 1,
      change: "created",
      ...snapshot,
      reason: op.reason,
      evidenceEventIds: op.evidenceEventIds.slice(0, MAX_EVIDENCE_IDS),
      runId: run.runId,
      actor: INTEL_ACTOR,
      createdAt: now,
    });
    return "created";
  }
  // A document digest is human_confirmed when a person wrote the document,
  // which mustn't freeze it: only a person's correction of it does.
  const byPerson =
    existing.updatedBy.type === "human" ||
    (op.sourceHash === undefined && existing.evidence === "human_confirmed");
  if (byPerson && evidenceRank(op.evidence) <= evidenceRank(existing.evidence)) return "protected";
  const evidenceEventIds = [...new Set([...op.evidenceEventIds, ...existing.evidenceEventIds])]
    .slice(0, MAX_EVIDENCE_IDS) as Id<"activity_events">[];
  const agentConnectionIds = [...new Set([...existing.agentConnectionIds, ...op.agentConnectionIds])]
    .slice(-10) as Id<"agent_connections">[];
  const fileIds = [...new Set([...existing.fileIds, ...op.fileIds])].slice(-20) as Id<"files">[];
  const severity = op.severity ?? existing.severity;
  const supersededBy =
    op.status === "superseded" ? (op.supersededBy ?? existing.supersededBy) : undefined;
  const sourceHash = op.sourceHash ?? existing.sourceHash;
  const unchanged =
    existing.title === snapshot.title &&
    existing.content === snapshot.content &&
    existing.status === snapshot.status &&
    existing.evidence === snapshot.evidence &&
    Math.abs(existing.confidence - snapshot.confidence) < 0.005 &&
    existing.severity === severity &&
    existing.supersededBy === supersededBy &&
    existing.sourceHash === sourceHash &&
    sameList(existing.evidenceEventIds, evidenceEventIds) &&
    sameList(existing.agentConnectionIds, agentConnectionIds) &&
    sameList(existing.fileIds, fileIds);
  if (unchanged) return null;
  const revision = existing.revision + 1;
  await ctx.db.patch(existing._id, {
    ...snapshot,
    evidenceEventIds,
    agentConnectionIds,
    fileIds,
    severity,
    supersededBy,
    sourceHash,
    ...(run.model !== undefined ? { model: run.model } : {}),
    lastRunId: run.runId,
    updatedBy: INTEL_ACTOR,
    revision,
    updatedAt: now,
  });
  await ctx.db.insert("context_entry_revisions", {
    workspaceId,
    entryId: existing._id,
    key: existing.key,
    revision,
    change: changeKind(existing, snapshot),
    ...snapshot,
    reason: op.reason,
    evidenceEventIds,
    runId: run.runId,
    actor: INTEL_ACTOR,
    createdAt: now,
  });
  return "updated";
}

/**
 * changeContextCore as the context manager. A nested mutation, so a refusal
 * (INVALID_INPUT, INVALID_SOURCE_FILE) rolls back on its own and the caller's
 * apply continues.
 */
export const recordContextChange = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    field: v.union(v.literal("goal"), v.literal("decision"), v.literal("ownership")),
    text: v.string(),
    ownerUserId: v.optional(v.string()),
    sourceFileIds: v.array(v.id("files")),
    supersedes: v.optional(v.string()),
  },
  returns: v.object({ entryId: v.union(v.string(), v.null()), deduplicated: v.boolean() }),
  handler: async (ctx, args) => {
    const result = await changeContextCore(ctx, {
      workspaceId: args.workspaceId,
      field: args.field,
      value: args.text,
      sourceFileIds: args.sourceFileIds,
      ...(args.ownerUserId !== undefined ? { ownerUserId: args.ownerUserId } : {}),
      ...(args.supersedes !== undefined ? { supersedes: args.supersedes } : {}),
      actor: INTEL_ACTOR,
    });
    return { entryId: result.entryId, deduplicated: result.deduplicated };
  },
});

/** An entry already recorded in project context (or refused), never tried again. */
const recorded = (e: Doc<"context_entries">) =>
  e.contextEntryId !== undefined || e.contextSkipped !== undefined ||
  e.proposalId !== undefined || e.proposalSkipped !== undefined;

/**
 * Why project context, as it stands now, overrules a change the batch
 * proposed, or null. Checked at apply time, since a person may have changed
 * context during the model call: a goal is only set while there is none, and
 * the context manager only replaces an owner it set itself (or a decision it
 * recorded itself, for compaction's supersede).
 */
async function overruled(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  c: Infer<typeof changeOpValidator>,
  fromCompaction: boolean,
): Promise<string | null> {
  const stored = await ctx.db
    .query("structured_context")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  if (!stored) return null;
  const context = normalizeContext(stored);
  if (c.field === "goal") return stored.goal?.text ? "project context already has a goal" : null;
  const active = (e: { status?: string }) => !e.status || e.status === "active";
  if (c.field === "ownership") {
    const current = context.ownership.find(
      (o) => active(o) && o.ownerArea !== undefined && nameKey(o.ownerArea) === nameKey(c.text),
    );
    return current && current.ownerUserId !== c.ownerUserId && current.updatedBy.type !== "system"
      ? "kept the owner a person or assistant set"
      : null;
  }
  if (fromCompaction && c.supersedes !== undefined) {
    const target = context.decisions.find((d) => d.id === c.supersedes);
    return target && target.updatedBy.type !== "system"
      ? "kept the decision a person or assistant recorded"
      : null;
  }
  return null;
}

/**
 * Records each finding in project context (recordContextChange) and links it
 * to the entry that tracks it. Returns how many changes it made; refusals go
 * to `dropped`.
 */
async function recordChanges(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  list: Infer<typeof changeOpValidator>[],
  dropped: string[],
  { fromCompaction = false } = {},
) {
  let changes = 0;
  for (const c of list) {
    const entry = c.field === "ownership" ? null : await getEntry(ctx, workspaceId, c.key);
    // Recorded before (and maybe since edited or removed by a person): don't
    // record it again. A supersede is a new change, so it always goes through.
    if (entry && recorded(entry) && c.supersedes === undefined) continue;
    const reason = await overruled(ctx, workspaceId, c, fromCompaction);
    if (reason) {
      dropped.push(`context change ${c.key}: ${reason}`);
      continue;
    }
    try {
      const result: { entryId: string | null; deduplicated: boolean } =
        await ctx.runMutation(internal.intel.recordContextChange, {
          workspaceId,
          field: c.field,
          text: c.text,
          ...(c.ownerUserId !== undefined ? { ownerUserId: c.ownerUserId } : {}),
          sourceFileIds: c.fileIds,
          ...(c.supersedes !== undefined ? { supersedes: c.supersedes } : {}),
        });
      if (entry && result.entryId !== null) await ctx.db.patch(entry._id, { contextEntryId: result.entryId });
      if (!result.deduplicated) changes++;
    } catch (err) {
      // INVALID_INPUT (an owner who left), INVALID_SOURCE_FILE and the like:
      // the finding stays an observed entry, marked so it isn't retried.
      const data = err instanceof ConvexError ? err.data : undefined;
      const parsed = typeof data === "string" ? (() => { try { return JSON.parse(data); } catch { return null; } })() : data;
      const code = parsed && typeof parsed === "object" && typeof parsed.code === "string" ? parsed.code : "ERROR";
      if (entry) await ctx.db.patch(entry._id, { contextSkipped: code });
      dropped.push(`context change ${c.key}: not recorded (${code})`);
    }
  }
  return changes;
}

const PROMOTE_PER_RUN = 3;
const PROMOTE_SCAN = 20;
// Content that narrates the observation rather than stating the finding.
const NARRATION = /^(observed|requested|claimed|document|the document|open question)\b|\b(said|says|reported|claims?)\b/i;

/**
 * Goal and decision findings the model recorded only as observed entries
 * (it often doesn't list them under context_changes) are recorded in
 * project context here. The entry links to what it recorded; one already
 * recorded, or whose recording was refused, is never tried again. Skips what
 * project context already says, and records a goal only while there is none.
 */
async function promoteFindings(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  dropped: string[],
  budget: number,
) {
  if (budget <= 0) return 0;
  const stored = await ctx.db
    .query("structured_context")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  const current = stored ? normalizeContext(stored) : null;
  const decisions = (current?.decisions ?? []).filter((d) => !d.status || d.status === "active").map((d) => d.text);
  let goalTaken = Boolean(stored?.goal?.text);
  let made = 0;
  for (const category of ["goal", "decision"] as const) {
    const rows = await ctx.db
      .query("context_entries")
      .withIndex("by_workspace_and_category_and_updated_at", (q) =>
        q.eq("workspaceId", workspaceId).eq("category", category),
      )
      .order("desc")
      .take(PROMOTE_SCAN);
    for (const e of rows) {
      if (made >= budget) return made;
      if (recorded(e) || e.status !== "active" || e.confidence < MIN_CHANGE_CONFIDENCE) continue;
      const text = !NARRATION.test(e.content) && e.content.length <= 500 ? e.content : e.title;
      if (category === "goal" && goalTaken) continue;
      if (category === "decision" && decisions.some((d) => normalize(d) === normalize(text) || similar(d, text))) {
        // Already in project context: mark it so it isn't re-checked every run.
        await ctx.db.patch(e._id, { contextSkipped: "DUPLICATE" });
        continue;
      }
      made += await recordChanges(ctx, workspaceId, [{
        field: category,
        text,
        confidence: e.confidence,
        evidenceEventIds: e.evidenceEventIds.slice(0, 3),
        fileIds: e.fileIds,
        key: e.key,
      }], dropped);
      if (category === "goal") goalTaken = true;
      else decisions.push(text);
    }
  }
  return made;
}

/** Schedules the next batch when events are still waiting; returns whether it did. */
async function scheduleIfPending(ctx: MutationCtx, workspaceId: Id<"workspaces">) {
  if ((await pendingEvents(ctx, workspaceId, 1)).length === 0) return false;
  const delay = batchWindowMs();
  await ctx.scheduler.runAfter(delay, internal.intel.processWorkspace, { workspaceId });
  await patchState(ctx, workspaceId, { status: "scheduled", scheduledFor: Date.now() + delay });
  return true;
}

/** Whether this run still holds the workspace (a crashed run's lease can be taken over). */
async function holdsLease(ctx: ReadCtx, workspaceId: Id<"workspaces">, runId: Id<"context_intel_runs">) {
  const run = await ctx.db.get(runId);
  const state = await getState(ctx, workspaceId);
  return run?.status === "running" && state?.lastRunId === runId ? { run, state } : null;
}

/**
 * Applies one validated result in one transaction. Stale (entriesRevision
 * moved since the batch was loaded: a person corrected an entry, or another
 * run applied) returns { stale: true } and writes nothing.
 */
export const applyResult = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    runId: v.id("context_intel_runs"),
    entriesRevision: v.number(),
    eventIds: v.array(v.id("activity_events")),
    summary: v.string(),
    entries: v.array(entryOpValidator),
    changes: v.array(changeOpValidator),
    dropped: v.array(v.string()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
  },
  returns: v.object({
    stale: v.boolean(),
    created: v.number(),
    updated: v.number(),
    contextChanges: v.number(),
  }),
  handler: async (ctx, args) => {
    const { workspaceId } = args;
    const none = { stale: false, created: 0, updated: 0, contextChanges: 0 };
    const held = await holdsLease(ctx, workspaceId, args.runId);
    if (!held) return none;
    const { run, state } = held;
    if (state.entriesRevision !== args.entriesRevision) return { ...none, stale: true };
    const now = Date.now();
    const meta = { runId: args.runId, model: run.model, now };
    const dropped = [...args.dropped];
    let created = 0;
    let updated = 0;
    for (const op of args.entries) {
      const outcome = await applyEntry(ctx, workspaceId, op, meta);
      if (outcome === "created") created++;
      else if (outcome === "updated") updated++;
      else if (outcome === "protected") dropped.push(`${op.key}: kept the person's version`);
    }

    const made = await recordChanges(ctx, workspaceId, args.changes, dropped);
    const contextChanges =
      made + (await promoteFindings(ctx, workspaceId, dropped, Math.min(PROMOTE_PER_RUN, MAX_RUN_CHANGES - made)));

    // A deleted document's digest leaves observed context with it; nothing
    // else would ever retract it (only a digest call writes doc keys).
    for (const id of args.eventIds) {
      const event = await ctx.db.get(id);
      const fileId = event?.type === "file.deleted" ? event.resources.find((r) => r.type === "file")?.id : undefined;
      const digest = fileId ? await getEntry(ctx, workspaceId, docKey(fileId)) : null;
      if (!event || !digest || digest.status === "retracted") continue;
      const outcome = await applyEntry(ctx, workspaceId, {
        op: "retract",
        key: digest.key,
        category: digest.category,
        title: digest.title,
        content: digest.content,
        status: "retracted",
        evidence: digest.evidence,
        confidence: digest.confidence,
        evidenceEventIds: [event._id, ...digest.evidenceEventIds].slice(0, MAX_EVIDENCE_IDS),
        agentConnectionIds: digest.agentConnectionIds,
        fileIds: digest.fileIds,
        ...(digest.severity !== undefined ? { severity: digest.severity } : {}),
        // Marks it as the digest it is, so a person-written document's
        // digest isn't mistaken for a person's own entry and kept.
        ...(digest.sourceHash !== undefined ? { sourceHash: digest.sourceHash } : {}),
        reason: "The document was deleted.",
      }, meta);
      if (outcome === "updated") updated++;
    }

    for (const id of args.eventIds) {
      const event = await ctx.db.get(id);
      // Only still-pending ones: a duplicate run never re-claims processed events.
      if (event?.intelStatus === "pending" && event.workspaceId === workspaceId)
        await ctx.db.patch(id, { intelStatus: "processed", intelRunId: args.runId });
    }
    const changed = created + updated > 0;
    const entriesRevision = state.entriesRevision + (changed ? 1 : 0);
    await ctx.db.patch(args.runId, {
      status: "succeeded",
      created,
      updated,
      contextChanges,
      summary: clip(args.summary || "No changes", 300),
      ...(dropped.length ? { error: clip(`Dropped: ${dropped.join("; ")}`, 500) } : {}),
      entriesRevision,
      ...(args.inputTokens !== undefined ? { inputTokens: args.inputTokens } : {}),
      ...(args.outputTokens !== undefined ? { outputTokens: args.outputTokens } : {}),
      finishedAt: now,
    });
    await patchState(ctx, workspaceId, {
      status: "idle",
      leaseExpiresAt: undefined,
      scheduledFor: undefined,
      consecutiveFailures: 0,
      nextRetryAt: undefined,
      lastRunAt: now,
      entriesRevision,
    });
    if (changed)
      await recordWorkspaceEvent(ctx, {
        workspaceId,
        kind: "context.observed",
        entityType: "context_entries",
        entityId: workspaceId,
        summary: clip(
          `Context manager: ${created} new, ${updated} updated${args.summary ? ` (${args.summary})` : ""}`,
          200,
        ),
        actor: INTEL_ACTOR,
      });
    await scheduleIfPending(ctx, workspaceId);
    return { stale: false, created, updated, contextChanges };
  },
});

/**
 * A failed model call: the events stay pending and the run retries with
 * exponential backoff (30 s × 2^(n-1), at most 10 min). After MAX_FAILURES
 * in a row it stops until a person retries from the dashboard.
 */
export const recordFailure = internalMutation({
  args: { workspaceId: v.id("workspaces"), runId: v.id("context_intel_runs"), error: v.string() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, runId, error }) => {
    const now = Date.now();
    const held = await holdsLease(ctx, workspaceId, runId);
    const run = held?.run ?? (await ctx.db.get(runId));
    if (!held) {
      if (run?.status === "running")
        await ctx.db.patch(runId, { status: "failed", error: clip(error, 120), finishedAt: now });
      return null;
    }
    const failures = held.state.consecutiveFailures + 1;
    const stop = failures >= MAX_FAILURES;
    await ctx.db.patch(runId, {
      status: "failed",
      error: clip(stop ? `${error}; automatic retries stopped after ${failures} failures` : error, 200),
      finishedAt: now,
    });
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
    if (!stop) await ctx.scheduler.runAfter(delay, internal.intel.processWorkspace, { workspaceId });
    await patchState(ctx, workspaceId, {
      status: "idle",
      leaseExpiresAt: undefined,
      scheduledFor: undefined,
      consecutiveFailures: failures,
      nextRetryAt: stop ? undefined : now + delay,
      lastRunAt: now,
    });
    return null;
  },
});

/** Stale twice in a row: leave the events pending and try again after the batch window. */
export const releaseStale = internalMutation({
  args: { workspaceId: v.id("workspaces"), runId: v.id("context_intel_runs") },
  returns: v.null(),
  handler: async (ctx, { workspaceId, runId }) => {
    if (!(await holdsLease(ctx, workspaceId, runId))) return null;
    const now = Date.now();
    await ctx.db.patch(runId, { status: "failed", error: "context changed during the run", finishedAt: now });
    await patchState(ctx, workspaceId, { status: "idle", leaseExpiresAt: undefined, lastRunAt: now });
    await scheduleIfPending(ctx, workspaceId);
    return null;
  },
});

/** INTEL_DISABLED at fire time: don't leave the workspace marked scheduled. */
export const releaseDisabled = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }) => {
    const state = await getState(ctx, workspaceId);
    if (state?.status === "scheduled")
      await patchState(ctx, workspaceId, { status: "idle", scheduledFor: undefined });
    return null;
  },
});

/** The next page of a backfill (lib/intelQueue.ts enqueueBackfillPage). */
export const continueBackfill = internalMutation({
  args: { workspaceId: v.id("workspaces"), cursor: v.string() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, cursor }) => {
    await enqueueBackfillPage(ctx, workspaceId, cursor, { requestRun: true });
    return null;
  },
});

const sectionValidator = v.object({
  category: entryFields.category,
  entries: v.array(
    v.object({
      key: v.string(),
      category: entryFields.category,
      title: v.string(),
      content: v.string(),
      status: entryFields.status,
      evidence: entryFields.evidence,
      confidence: v.number(),
      evidenceEventIds: v.array(v.string()),
      severity: entryFields.severity,
      agentConnectionIds: v.array(v.string()),
      fileIds: v.array(v.string()),
      protected: v.boolean(),
    }),
  ),
  contextDecisions: v.array(v.object({ id: v.string(), text: v.string() })),
});

/** A person confirmed or corrected it: compaction never folds it. */
async function isProtected(ctx: ReadCtx, entry: Doc<"context_entries">) {
  if (entry.evidence === "human_confirmed" || entry.updatedBy.type === "human") return true;
  const revisions = await ctx.db
    .query("context_entry_revisions")
    .withIndex("by_entry_and_revision", (q) => q.eq("entryId", entry._id))
    .order("desc")
    .take(20);
  return revisions.some((r) => r.change === "corrected");
}

/**
 * The sections over their COMPACT_THRESHOLDS count of live entries, each with
 * its newest MAX_COMPACT_INPUT live entries, and the entriesRevision they
 * were read at.
 */
export const loadCompaction = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ entriesRevision: v.number(), sections: v.array(sectionValidator) }),
  handler: async (ctx, { workspaceId }) => {
    const state = await getState(ctx, workspaceId);
    const sections: CompactSection[] = [];
    for (const [category, threshold] of Object.entries(COMPACT_THRESHOLDS) as [Category, number][]) {
      const live = (
        await ctx.db
          .query("context_entries")
          .withIndex("by_workspace_and_category_and_updated_at", (q) =>
            q.eq("workspaceId", workspaceId).eq("category", category),
          )
          .order("desc")
          .take(COMPACT_SCAN)
      ).filter((e) => LIVE_STATUSES.includes(e.status) && !e.key.startsWith(DOC_KEY_PREFIX));
      if (live.length <= threshold) continue;
      const entries: CompactSection["entries"] = [];
      for (const e of live.slice(0, MAX_COMPACT_INPUT))
        entries.push({
          key: e.key,
          category: e.category,
          title: e.title,
          content: e.content,
          status: e.status,
          evidence: e.evidence,
          confidence: e.confidence,
          evidenceEventIds: e.evidenceEventIds,
          ...(e.severity !== undefined ? { severity: e.severity } : {}),
          agentConnectionIds: e.agentConnectionIds,
          fileIds: e.fileIds,
          protected: await isProtected(ctx, e),
        });
      let contextDecisions: CompactSection["contextDecisions"] = [];
      if (category === "decision") {
        try {
          contextDecisions = (await loadContext(ctx, workspaceId)).decisions
            .filter((d) => d.status === "active")
            .map((d) => ({ id: d.id, text: d.text }));
        } catch {
          // CONTEXT_NOT_INITIALIZED: no project context yet.
        }
      }
      sections.push({ category, entries, contextDecisions });
    }
    return { entriesRevision: state?.entriesRevision ?? 0, sections };
  },
});

/**
 * Applies the run's compaction results in one transaction, guarded by
 * entriesRevision like applyResult (stale writes nothing). Merged entries are
 * upserts and every folded entry a supersede, each with a revision; at most
 * one decision supersede is recorded in project context.
 */
export const applyCompaction = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    runId: v.id("context_intel_runs"),
    entriesRevision: v.number(),
    summary: v.string(),
    entries: v.array(entryOpValidator),
    changes: v.array(changeOpValidator),
    dropped: v.array(v.string()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
  },
  returns: v.object({ stale: v.boolean(), superseded: v.number(), contextChanges: v.number() }),
  handler: async (ctx, args) => {
    const { workspaceId } = args;
    const run = await ctx.db.get(args.runId);
    if (!run || run.workspaceId !== workspaceId) return { stale: false, superseded: 0, contextChanges: 0 };
    const state = await getState(ctx, workspaceId);
    const errorWith = (more: string[]) =>
      more.length ? { error: clip([run.error, `Compaction: ${more.join("; ")}`].filter(Boolean).join(" "), 500) } : {};
    if (!state || state.entriesRevision !== args.entriesRevision) {
      await ctx.db.patch(run._id, errorWith(["skipped, context changed"]));
      return { stale: true, superseded: 0, contextChanges: 0 };
    }
    const now = Date.now();
    const meta = { runId: run._id, model: run.model, now };
    const dropped = [...args.dropped];
    let created = 0;
    let updated = 0;
    let superseded = 0;
    for (const op of args.entries) {
      const outcome = await applyEntry(ctx, workspaceId, op, meta);
      if (outcome === "created") created++;
      else if (outcome === "updated") updated++;
      else if (outcome === "protected") dropped.push(`${op.key}: kept the person's version`);
      if (outcome === "updated" && op.op === "supersede") superseded++;
    }
    // A merged entry keeps the context link (or refusal) of what it folded,
    // so promotion doesn't record an already-recorded finding again.
    for (const op of args.entries) {
      if (op.op !== "supersede" || op.supersededBy === undefined) continue;
      const folded = await getEntry(ctx, workspaceId, op.key);
      const merged = await getEntry(ctx, workspaceId, op.supersededBy);
      if (!folded || !merged || recorded(merged) || !recorded(folded)) continue;
      await ctx.db.patch(merged._id, folded.contextEntryId !== undefined
        ? { contextEntryId: folded.contextEntryId }
        : { contextSkipped: folded.contextSkipped ?? folded.proposalSkipped ?? "PROPOSED" });
    }
    const contextChanges = await recordChanges(ctx, workspaceId, args.changes, dropped, { fromCompaction: true });
    const changed = created + updated > 0;
    const entriesRevision = state.entriesRevision + (changed ? 1 : 0);
    const add = (a: number | undefined, b: number | undefined) =>
      a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
    const inputTokens = add(run.inputTokens, args.inputTokens);
    const outputTokens = add(run.outputTokens, args.outputTokens);
    await ctx.db.patch(run._id, {
      created: run.created + created,
      updated: run.updated + updated,
      contextChanges: (run.contextChanges ?? 0) + contextChanges,
      ...(changed
        ? { entriesRevision, summary: clip(`${run.summary ?? ""} Compacted ${superseded} entries${args.summary ? ` (${args.summary})` : ""}.`.trim(), 300) }
        : {}),
      ...errorWith(dropped),
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
    });
    if (changed) {
      await patchState(ctx, workspaceId, { entriesRevision });
      await recordWorkspaceEvent(ctx, {
        workspaceId,
        kind: "context.observed",
        entityType: "context_entries",
        entityId: workspaceId,
        summary: clip(
          `Context manager compacted ${superseded} entries${args.summary ? ` (${args.summary})` : ""}`,
          200,
        ),
        actor: INTEL_ACTOR,
      });
    }
    return { stale: false, superseded, contextChanges };
  },
});

type Usage = { inputTokens?: number; outputTokens?: number };
type Analysis = { result: IntelResult } & Usage;
type ModelCall = { system: string; schema: unknown; content: string; timeoutMs: number };

/**
 * One Messages API call; throws with a short reason, never a provider body.
 * The system prompt is a cached block; cache reads and writes count as input.
 */
async function askModel(key: string, model: string, call: ModelCall) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), call.timeoutMs);
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        // Haiku 5.5 rejects sampling parameters; structured outputs keep the
        // reply on the schema and low effort keeps the call cheap.
        output_config: { effort: "low", format: { type: "json_schema", schema: call.schema } },
        system: systemBlocks(call.system),
        messages: [{ role: "user", content: call.content }],
      }),
      signal: controller.signal,
    });
  } catch {
    throw new Error(controller.signal.aborted ? "timeout" : "request failed");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let body: {
    content?: { type: string; text?: string }[];
    stop_reason?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  try {
    body = await res.json();
  } catch {
    throw new IntelParseError();
  }
  if (body.stop_reason === "refusal") throw new Error("model refused");
  // Partial JSON would only fail as unparseable, the same way every retry;
  // claimBatch halves the batch after this error instead.
  if (body.stop_reason === "max_tokens") throw new Error(TRUNCATED);
  const text = (body.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  const usage = body.usage;
  const inputTokens =
    usage?.input_tokens === undefined
      ? undefined
      : usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  return { text, inputTokens, outputTokens: usage?.output_tokens };
}

/** A model call's parsed JSON (validation is the caller's). */
async function callModel(model: string | undefined, call: ModelCall): Promise<{ raw: unknown } & Usage> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("no API key");
  const reply = await askModel(key, model ?? contextModel(), call);
  const raw = extractJson(reply.text);
  if (!raw) throw new IntelParseError();
  return {
    raw,
    ...(reply.inputTokens !== undefined ? { inputTokens: reply.inputTokens } : {}),
    ...(reply.outputTokens !== undefined ? { outputTokens: reply.outputTokens } : {}),
  };
}

/** Runs the tasks CONCURRENCY at a time; the first failure rejects. */
async function pooled<T>(tasks: (() => Promise<T>)[]): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < tasks.length; i += CONCURRENCY)
    out.push(...(await Promise.all(tasks.slice(i, i + CONCURRENCY).map((task) => task()))));
  return out;
}

const usageOf = ({ inputTokens, outputTokens }: Usage): Usage => ({
  ...(inputTokens !== undefined ? { inputTokens } : {}),
  ...(outputTokens !== undefined ? { outputTokens } : {}),
});

/** The activity half: every event but the backfill markers, without document content. */
async function analyzeActivity(batch: Batch): Promise<Analysis | null> {
  const events = batch.events.filter((e) => e.type !== "file.backfill");
  if (events.length === 0) return null;
  const scoped = { ...batch, events };
  if (batch.method === "heuristic")
    return { result: validateIntelOutput(withDeterministic(heuristicOutput(scoped), scoped), scoped) };
  const reply = await callModel(batch.model, {
    system: SYSTEM_PROMPT,
    schema: RESPONSE_SCHEMA,
    content: userMessage(scoped),
    timeoutMs: TIMEOUT_MS,
  });
  return { result: validateIntelOutput(withDeterministic(reply.raw, scoped), scoped), ...usageOf(reply) };
}

/**
 * One document's digest call (or the deterministic digest without a model).
 * A failure that would repeat on every retry (a refusal, unparseable or
 * truncated output for this text) falls back to the deterministic digest, so
 * one document can't hold every later batch; transient failures still fail
 * the run and retry.
 */
async function analyzeDocument(doc: DocumentInput, batch: Batch): Promise<Analysis> {
  if (batch.method === "heuristic") return { result: heuristicDigest(doc) };
  try {
    const reply = await callModel(batch.model, {
      system: DIGEST_SYSTEM_PROMPT,
      schema: DIGEST_RESPONSE_SCHEMA,
      content: digestMessage(doc, batch),
      timeoutMs: DIGEST_TIMEOUT_MS,
    });
    return { result: validateDigest(reply.raw, doc, batch), ...usageOf(reply) };
  } catch (err) {
    const why = knownError(err);
    if (why !== "model refused" && why !== "unparseable response" && why !== TRUNCATED) throw err;
    const fallback = heuristicDigest(doc);
    return { result: { ...fallback, dropped: [`${doc.name}: ${why}; kept a plain summary`] } };
  }
}

// Filler that would make unrelated statements look alike ("We will use
// Stripe for payments" vs "We will use Vercel for hosting").
const FILLER = new Set([
  "the", "and", "for", "with", "use", "uses", "using", "will", "shall", "should", "must", "our",
  "we", "all", "any", "from", "into", "this", "that", "these", "those", "are", "was", "were",
  "has", "have", "via", "per", "its", "their", "them", "they", "then", "than", "also", "only",
  "team", "project", "app", "data",
]);
// A reversal ("don't use X", "drop X", "X instead of Y") is a change to
// propose, never a duplicate of X.
const NEGATION = /\b(not|no|never|don'?t|doesn'?t|won'?t|drop|stop|remove|replace|instead|without|ruled out)\b/i;

const words = (text: string) =>
  new Set(
    normalize(text)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3 && !FILLER.has(w)),
  );

/**
 * Says the same thing, and neither negates what the other states. "strict"
 * (deciding a finding is already in project context) needs most content
 * words of both to coincide; "restates" (an entry's title and content
 * against the change text it came with, which adds words) only needs most
 * of the shorter's in the longer.
 */
function similar(a: string, b: string, mode: "strict" | "restates" = "strict"): boolean {
  if (NEGATION.test(a) !== NEGATION.test(b)) return false;
  const [x, y] = [words(a), words(b)];
  const [small, large] = x.size <= y.size ? [x, y] : [y, x];
  if (small.size === 0) return false;
  let shared = 0;
  for (const w of small) if (large.has(w)) shared++;
  return mode === "restates"
    ? shared / small.size >= 0.6
    : shared / small.size >= 0.75 && shared / large.size >= 0.5;
}

/**
 * The activity call and every digest call, CONCURRENCY at a time. Any failure
 * fails the whole analysis, so no event is marked processed unless every
 * document in the batch was read. Results merge into one: the later call
 * wins a shared key; context changes dedupe, at most MAX_RUN_CHANGES, one
 * goal and one that supersedes a decision.
 */
async function analyze(batch: Batch): Promise<Analysis> {
  const [activity, ...digests] = await pooled<Analysis | null>([
    () => analyzeActivity(batch),
    ...batch.documents.map((doc) => () => analyzeDocument(doc, batch)),
  ]);
  const parts = [activity, ...digests].filter((p): p is Analysis => p !== null);
  const entries = new Map<string, IntelResult["entries"][number]>();
  const fromActivity = new Map<string, boolean>();
  const changes: IntelResult["changes"] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  let superseding = false;
  let goal = false;
  for (const { result } of parts) {
    dropped.push(...result.dropped);
    for (const e of result.entries) {
      if (entries.has(e.key)) dropped.push(`${e.key}: from two calls; the later one wins`);
      entries.set(e.key, e);
      fromActivity.set(e.key, result === activity?.result);
    }
    for (const c of result.changes) {
      const id = c.field === "ownership" ? `ownership:${normalize(c.text)}:${c.ownerUserId}` : `${c.field}:${normalize(c.text)}`;
      if (seen.has(id)) continue;
      if (c.supersedes !== undefined && superseding) {
        dropped.push(`context change ${c.key}: one superseding change per run`);
        continue;
      }
      if (c.field === "goal" && goal) {
        dropped.push(`context change ${c.key}: one goal per run`);
        continue;
      }
      if (changes.length >= MAX_RUN_CHANGES) {
        dropped.push(`context change ${c.key}: at most ${MAX_RUN_CHANGES} context changes per run`);
        continue;
      }
      seen.add(id);
      if (c.supersedes !== undefined) superseding = true;
      if (c.field === "goal") goal = true;
      changes.push(c);
    }
  }
  // The prompts ask for this too, but the model doesn't reliably comply:
  // a document's digest is its knowledge record (the activity call only saw a
  // preview), and a context change's companion entry is its decision/goal record.
  const digested = new Set(batch.documents.map((d) => d.fileId as string));
  // Only new records are dropped: a change to an existing entry (say, a
  // supersede of the decision a document just replaced) always applies.
  const existing = new Set(batch.entries.map((e) => e.key));
  for (const e of [...entries.values()]) {
    const added = e.op === "upsert" && !existing.has(e.key);
    const aboutDigested =
      added && fromActivity.get(e.key) === true && e.category === "knowledge" &&
      e.fileIds.length > 0 && e.fileIds.every((id) => digested.has(id));
    const covered =
      added && (e.category === "decision" || e.category === "goal") &&
      !changes.some((c) => c.key === e.key) &&
      changes.some((c) => c.field === e.category && similar(c.text, `${e.title} ${e.content}`, "restates"));
    if (aboutDigested || covered) {
      entries.delete(e.key);
      dropped.push(`${e.key}: ${aboutDigested ? "the document's digest covers it" : "covered by its context change"}`);
    }
  }
  const read = batch.documents.length;
  const summary = [activity?.result.summary, read ? `Read ${read} document${read === 1 ? "" : "s"}` : ""]
    .filter(Boolean)
    .join("; ");
  const sum = (key: keyof Usage) =>
    parts.some((p) => p[key] !== undefined) ? parts.reduce((n, p) => n + (p[key] ?? 0), 0) : undefined;
  return {
    result: { summary, entries: [...entries.values()], changes, dropped },
    ...usageOf({ inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens") }),
  };
}

const KNOWN_ERRORS = /^(timeout|request failed|HTTP \d{3}|unparseable response|model refused|no API key|output truncated)$/;
const knownError = (err: unknown) => {
  const message = err instanceof Error ? err.message : "";
  return KNOWN_ERRORS.test(message) ? message : "internal error";
};

/**
 * Compacts every section over its threshold, one model call per section
 * (after a successful apply that changed something; model mode only). A
 * failed call only skips its section; the run has already succeeded.
 */
async function compact(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; runId: Id<"context_intel_runs">; model?: string; allowSupersede: boolean },
) {
  const { entriesRevision, sections } = await ctx.runQuery(internal.intel.loadCompaction, {
    workspaceId: args.workspaceId,
  });
  if (sections.length === 0) return;
  const dropped: string[] = [];
  const results = await pooled(
    sections.map((section) => async (): Promise<Analysis | null> => {
      try {
        const reply = await callModel(args.model, {
          system: COMPACT_SYSTEM_PROMPT,
          schema: COMPACT_RESPONSE_SCHEMA,
          content: compactMessage(section),
          timeoutMs: TIMEOUT_MS,
        });
        return { result: validateCompaction(reply.raw, section, args.allowSupersede), ...usageOf(reply) };
      } catch (err) {
        dropped.push(`${section.category} failed (${knownError(err)})`);
        return null;
      }
    }),
  );
  const parts = results.filter((r): r is Analysis => r !== null);
  const entries = parts.flatMap((p) => p.result.entries);
  const changes = parts.flatMap((p) => p.result.changes).slice(0, 1);
  dropped.push(...parts.flatMap((p) => p.result.dropped));
  if (entries.length === 0 && changes.length === 0 && dropped.length === 0) return;
  const sum = (key: keyof Usage) =>
    parts.some((p) => p[key] !== undefined) ? parts.reduce((n, p) => n + (p[key] ?? 0), 0) : undefined;
  await ctx.runMutation(internal.intel.applyCompaction, {
    workspaceId: args.workspaceId,
    runId: args.runId,
    entriesRevision,
    summary: parts.map((p) => p.result.summary).filter(Boolean).join("; "),
    entries: entries as EntryOpArg[],
    changes: changes as Infer<typeof changeOpValidator>[],
    dropped,
    ...usageOf({ inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens") }),
  });
}

export const processWorkspace = internalAction({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }) => {
    if (intelDisabled()) {
      await ctx.runMutation(internal.intel.releaseDisabled, { workspaceId });
      return null;
    }
    let batch: Batch | null = await ctx.runMutation(internal.intel.claimBatch, { workspaceId });
    if (!batch) return null;
    for (let attempt = 1; ; attempt++) {
      let analysis: Analysis;
      try {
        analysis = await analyze(batch);
      } catch (err) {
        await ctx.runMutation(internal.intel.recordFailure, {
          workspaceId,
          runId: batch.runId,
          error: knownError(err),
        });
        return null;
      }
      const { result } = analysis;
      const applied: { stale: boolean; created: number; updated: number } = await ctx.runMutation(
        internal.intel.applyResult,
        {
          workspaceId,
          runId: batch.runId,
          entriesRevision: batch.entriesRevision,
          eventIds: batch.events.map((e) => e.id as Id<"activity_events">),
          summary: result.summary,
          entries: result.entries as EntryOpArg[],
          changes: result.changes as Infer<typeof changeOpValidator>[],
          dropped: result.dropped,
          ...usageOf(analysis),
        },
      );
      if (!applied.stale) {
        if (batch.method === "llm" && applied.created + applied.updated > 0)
          await compact(ctx, {
            workspaceId,
            runId: batch.runId,
            model: batch.model,
            allowSupersede: !result.changes.some((c) => c.supersedes !== undefined),
          });
        return null;
      }
      // Retry once against fresh state; then leave the events for a later run.
      const fresh: Batch | null = attempt < 2
        ? await ctx.runQuery(internal.intel.reloadBatch, { workspaceId, runId: batch.runId })
        : null;
      if (!fresh) {
        await ctx.runMutation(internal.intel.releaseStale, { workspaceId, runId: batch.runId });
        return null;
      }
      batch = fresh;
    }
  },
});
