// The dashboard's view of context intelligence (docs/context-intelligence.md):
// the raw activity feed, the observed (derived, never approved) context state,
// its change history with evidence, and human correction. Every function
// checks membership first; every read is bounded and stays inside the
// workspace, including ids stored on rows (evidence, files, connections).
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { agentActor } from "./lib/agent";
import { humanActor, recordWorkspaceEvent, requireMembership } from "./lib/auth";
import { intelDisabled } from "./lib/intelQueue";
import { actorValidator, proposalStatusValidator } from "./lib/validators";

type ReadCtx = QueryCtx | MutationCtx;

const ENTRY_LIMIT = 100;
const PENDING_SCAN = 101;
const FEED_SCAN = 200;
const FEED_DEFAULT = 50;
const FEED_MAX = 100;
const CHANGES_DEFAULT = 30;
const CHANGES_MAX = 50;
const RUNS_LIMIT = 20;
const HISTORY_LIMIT = 50;
const EVIDENCE_LIMIT = 50;
const AGENTS_PER_ENTRY = 10;
const FILES_PER_ENTRY = 20;
const MAX_TITLE = 200;
const MAX_CONTENT = 4000;
const MAX_NOTE = 500;

const sourceValidator = v.union(
  v.literal("mcp"),
  v.literal("claude_code"),
  v.literal("workspace"),
  v.literal("simulator"),
);
const categoryValidator = v.union(
  v.literal("goal"),
  v.literal("objective"),
  v.literal("decision"),
  v.literal("task"),
  v.literal("progress"),
  v.literal("blocker"),
  v.literal("knowledge"),
  v.literal("agent_summary"),
  v.literal("coordination"),
);
const statusValidator = v.union(
  v.literal("active"),
  v.literal("completed"),
  v.literal("resolved"),
  v.literal("superseded"),
  v.literal("retracted"),
);
const evidenceValidator = v.union(
  v.literal("requested"),
  v.literal("claimed"),
  v.literal("observed"),
  v.literal("verified"),
  v.literal("human_confirmed"),
);
const changeValidator = v.union(
  v.literal("created"),
  v.literal("updated"),
  v.literal("status_changed"),
  v.literal("superseded"),
  v.literal("reopened"),
  v.literal("corrected"),
);
const runStatusValidator = v.union(
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("skipped"),
);
const methodValidator = v.union(v.literal("llm"), v.literal("heuristic"));

const agentRefValidator = v.object({
  connectionId: v.id("agent_connections"),
  label: v.string(),
  client: v.string(),
});

const entryValidator = v.object({
  id: v.id("context_entries"),
  key: v.string(),
  category: categoryValidator,
  title: v.string(),
  content: v.string(),
  status: statusValidator,
  evidence: evidenceValidator,
  confidence: v.number(),
  severity: v.union(v.literal("potential"), v.literal("actual"), v.null()),
  supersededBy: v.union(v.string(), v.null()),
  revision: v.number(),
  evidenceEventIds: v.array(v.id("activity_events")),
  agents: v.array(agentRefValidator),
  files: v.array(v.object({ id: v.id("files"), name: v.string(), deleted: v.boolean() })),
  proposal: v.union(
    v.object({ id: v.id("context_proposals"), status: proposalStatusValidator }),
    v.null(),
  ),
  model: v.union(v.string(), v.null()),
  createdBy: actorValidator,
  updatedBy: actorValidator,
  createdAt: v.number(),
  updatedAt: v.number(),
});

const activityEventValidator = v.object({
  id: v.id("activity_events"),
  source: sourceValidator,
  type: v.string(),
  tool: v.union(v.string(), v.null()),
  outcome: v.union(v.literal("ok"), v.literal("conflict"), v.literal("error")),
  errorCode: v.union(v.string(), v.null()),
  summary: v.string(),
  actor: actorValidator,
  agentConnectionId: v.union(v.id("agent_connections"), v.null()),
  resources: v.array(
    v.object({ type: v.string(), id: v.string(), label: v.union(v.string(), v.null()) }),
  ),
  sessionId: v.union(v.string(), v.null()),
  correlationId: v.union(v.string(), v.null()),
  significant: v.boolean(),
  intelStatus: v.union(v.literal("pending"), v.literal("processed"), v.literal("skipped")),
  intelRunId: v.union(v.id("context_intel_runs"), v.null()),
  // Already redacted and size-capped at ingestion; untrusted text.
  payload: v.union(v.string(), v.null()),
  occurredAt: v.number(),
  createdAt: v.number(),
});

const runRefValidator = v.object({
  id: v.id("context_intel_runs"),
  status: runStatusValidator,
  method: methodValidator,
  model: v.union(v.string(), v.null()),
});

const revisionValidator = v.object({
  id: v.id("context_entry_revisions"),
  entryId: v.id("context_entries"),
  key: v.string(),
  category: categoryValidator,
  revision: v.number(),
  change: changeValidator,
  title: v.string(),
  content: v.string(),
  status: statusValidator,
  evidence: evidenceValidator,
  confidence: v.number(),
  reason: v.string(),
  evidenceCount: v.number(),
  actor: actorValidator,
  run: v.union(runRefValidator, v.null()),
  // Who the newest evidence came from, for "from Alex's Claude Code activity".
  evidenceSource: v.union(
    v.object({ label: v.string(), source: sourceValidator }),
    v.null(),
  ),
  createdAt: v.number(),
});

const runValidator = v.object({
  id: v.id("context_intel_runs"),
  status: runStatusValidator,
  method: methodValidator,
  model: v.union(v.string(), v.null()),
  summary: v.union(v.string(), v.null()),
  error: v.union(v.string(), v.null()),
  eventCount: v.number(),
  proposals: v.number(),
  startedAt: v.number(),
  finishedAt: v.union(v.number(), v.null()),
});

/** Agent labels for connection ids, cached per request; other workspaces' ids drop out. */
function agentResolver(ctx: ReadCtx, workspaceId: Id<"workspaces">) {
  const cache = new Map<Id<"agent_connections">, typeof agentRefValidator.type | null>();
  const users = new Map<Id<"users">, Doc<"users"> | null>();
  return async (connectionId: Id<"agent_connections">) => {
    if (cache.has(connectionId)) return cache.get(connectionId)!;
    const connection = await ctx.db.get(connectionId);
    let ref: typeof agentRefValidator.type | null = null;
    if (connection?.workspaceId === workspaceId) {
      if (!users.has(connection.userId)) users.set(connection.userId, await ctx.db.get(connection.userId));
      const user = users.get(connection.userId);
      ref = {
        connectionId,
        label: user
          ? agentActor(connection, user).label
          : (connection.displayName ?? `Workspace member's ${connection.client} assistant`),
        client: connection.client,
      };
    }
    cache.set(connectionId, ref);
    return ref;
  };
}

async function toEntry(
  ctx: ReadCtx,
  entry: Doc<"context_entries">,
  agentRef: ReturnType<typeof agentResolver>,
): Promise<typeof entryValidator.type> {
  const agents = [];
  for (const id of entry.agentConnectionIds.slice(0, AGENTS_PER_ENTRY)) {
    const ref = await agentRef(id);
    if (ref) agents.push(ref);
  }
  const files = [];
  for (const id of entry.fileIds.slice(0, FILES_PER_ENTRY)) {
    const file = await ctx.db.get(id);
    if (file?.workspaceId === entry.workspaceId)
      files.push({ id, name: file.name, deleted: file.deletedAt !== undefined });
  }
  const proposal = entry.proposalId ? await ctx.db.get(entry.proposalId) : null;
  return {
    id: entry._id,
    key: entry.key,
    category: entry.category,
    title: entry.title,
    content: entry.content,
    status: entry.status,
    evidence: entry.evidence,
    confidence: entry.confidence,
    severity: entry.severity ?? null,
    supersededBy: entry.supersededBy ?? null,
    revision: entry.revision,
    evidenceEventIds: entry.evidenceEventIds,
    agents,
    files,
    proposal:
      proposal && proposal.workspaceId === entry.workspaceId
        ? { id: proposal._id, status: proposal.status }
        : null,
    model: entry.model ?? null,
    createdBy: entry.createdBy,
    updatedBy: entry.updatedBy,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function toEvent(row: Doc<"activity_events">): typeof activityEventValidator.type {
  return {
    id: row._id,
    source: row.source,
    type: row.type,
    tool: row.tool ?? null,
    outcome: row.outcome,
    errorCode: row.errorCode ?? null,
    summary: row.summary,
    actor: row.actor,
    agentConnectionId: row.agentConnectionId ?? null,
    resources: row.resources.map((r) => ({ type: r.type, id: r.id, label: r.label ?? null })),
    sessionId: row.sessionId ?? null,
    correlationId: row.correlationId ?? null,
    significant: row.significant,
    intelStatus: row.intelStatus,
    intelRunId: row.intelRunId ?? null,
    payload: row.payload ?? null,
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
  };
}

function toRunRef(run: Doc<"context_intel_runs">): typeof runRefValidator.type {
  return { id: run._id, status: run.status, method: run.method, model: run.model ?? null };
}

async function intelState(ctx: ReadCtx, workspaceId: Id<"workspaces">) {
  return await ctx.db
    .query("context_intel_state")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

/**
 * The observed context state, newest entries first, with the context
 * manager's status. Observed, not approved: only structured_context is.
 */
export const getObservedContext = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({
    revision: v.number(),
    lastRunAt: v.union(v.number(), v.null()),
    status: v.union(v.literal("idle"), v.literal("scheduled"), v.literal("running")),
    consecutiveFailures: v.number(),
    nextRetryAt: v.union(v.number(), v.null()),
    /** Pending significant events; PENDING_SCAN (101) means "more than 100". */
    pendingEvents: v.number(),
    lastRun: v.union(
      v.object({
        status: runStatusValidator,
        method: methodValidator,
        model: v.union(v.string(), v.null()),
        summary: v.union(v.string(), v.null()),
        error: v.union(v.string(), v.null()),
        finishedAt: v.union(v.number(), v.null()),
      }),
      v.null(),
    ),
    entries: v.array(entryValidator),
  }),
  handler: async (ctx, { workspaceId }) => {
    await requireMembership(ctx, workspaceId);
    const state = await intelState(ctx, workspaceId);
    const pending = await ctx.db
      .query("activity_events")
      .withIndex("by_workspace_and_intel_status_and_created", (q) =>
        q.eq("workspaceId", workspaceId).eq("intelStatus", "pending"),
      )
      .take(PENDING_SCAN);
    let run = state?.lastRunId ? await ctx.db.get(state.lastRunId) : null;
    if (!run || run.workspaceId !== workspaceId)
      run = await ctx.db
        .query("context_intel_runs")
        .withIndex("by_workspace_and_started_at", (q) => q.eq("workspaceId", workspaceId))
        .order("desc")
        .first();
    const rows = await ctx.db
      .query("context_entries")
      .withIndex("by_workspace_and_updated_at", (q) => q.eq("workspaceId", workspaceId))
      .order("desc")
      .take(ENTRY_LIMIT);
    const agentRef = agentResolver(ctx, workspaceId);
    const entries = [];
    for (const row of rows) entries.push(await toEntry(ctx, row, agentRef));
    return {
      revision: state?.entriesRevision ?? 0,
      lastRunAt: state?.lastRunAt ?? null,
      status: state?.status ?? "idle",
      consecutiveFailures: state?.consecutiveFailures ?? 0,
      nextRetryAt: state?.nextRetryAt ?? null,
      pendingEvents: pending.length,
      lastRun: run
        ? {
            status: run.status,
            method: run.method,
            model: run.model ?? null,
            summary: run.summary ?? null,
            error: run.error ?? null,
            finishedAt: run.finishedAt ?? null,
          }
        : null,
      entries,
    };
  },
});

/** A row's place in the feed: createdAt, then _creationTime for ties. */
interface FeedKey {
  createdAt: number;
  creationTime: number;
}

const encodeCursor = (key: FeedKey) => `${key.createdAt}:${key.creationTime}`;

function decodeCursor(cursor: string): FeedKey {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(cursor);
  const key = match && { createdAt: Number(match[1]), creationTime: Number(match[2]) };
  if (!key || !Number.isFinite(key.createdAt) || !Number.isFinite(key.creationTime))
    throw new ConvexError({ code: "INVALID_INPUT", field: "before" });
  return key;
}

/**
 * Raw activity_events, newest first: MCP calls, Claude Code hooks, workspace
 * changes and simulated events. Pages by `before` (opaque, exclusive; pass
 * the previous nextBefore). At most FEED_SCAN rows are read per page, so a
 * page filtered by source can be short while nextBefore is still set.
 */
export const listActivityEvents = query({
  args: {
    workspaceId: v.id("workspaces"),
    before: v.optional(v.string()),
    limit: v.optional(v.number()),
    sources: v.optional(v.array(sourceValidator)),
    connectionId: v.optional(v.id("agent_connections")),
  },
  returns: v.object({
    items: v.array(activityEventValidator),
    nextBefore: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    await requireMembership(ctx, args.workspaceId);
    const limit = Math.min(FEED_MAX, Math.max(1, Math.floor(args.limit ?? FEED_DEFAULT)));
    const before = args.before === undefined ? null : decodeCursor(args.before);
    const sources = args.sources?.length ? new Set<string>(args.sources) : null;

    let rows: Doc<"activity_events">[] = [];
    if (args.connectionId !== undefined) {
      const connection = await ctx.db.get(args.connectionId);
      // Another workspace's connection reads as empty, like an unknown one.
      if (connection?.workspaceId !== args.workspaceId) return { items: [], nextBefore: null };
      const id = connection._id;
      if (before) {
        rows = await ctx.db
          .query("activity_events")
          .withIndex("by_connection_and_created", (q) =>
            q
              .eq("agentConnectionId", id)
              .eq("createdAt", before.createdAt)
              .lt("_creationTime", before.creationTime),
          )
          .order("desc")
          .take(FEED_SCAN);
      }
      if (rows.length < FEED_SCAN)
        rows.push(
          ...(await ctx.db
            .query("activity_events")
            .withIndex("by_connection_and_created", (q) => {
              const scoped = q.eq("agentConnectionId", id);
              return before ? scoped.lt("createdAt", before.createdAt) : scoped;
            })
            .order("desc")
            .take(FEED_SCAN - rows.length)),
        );
    } else {
      if (before) {
        rows = await ctx.db
          .query("activity_events")
          .withIndex("by_workspace_and_created", (q) =>
            q
              .eq("workspaceId", args.workspaceId)
              .eq("createdAt", before.createdAt)
              .lt("_creationTime", before.creationTime),
          )
          .order("desc")
          .take(FEED_SCAN);
      }
      if (rows.length < FEED_SCAN)
        rows.push(
          ...(await ctx.db
            .query("activity_events")
            .withIndex("by_workspace_and_created", (q) => {
              const scoped = q.eq("workspaceId", args.workspaceId);
              return before ? scoped.lt("createdAt", before.createdAt) : scoped;
            })
            .order("desc")
            .take(FEED_SCAN - rows.length)),
        );
    }

    const items: (typeof activityEventValidator.type)[] = [];
    let cutAt: Doc<"activity_events"> | null = null;
    for (const row of rows) {
      if (sources && !sources.has(row.source)) continue;
      items.push(toEvent(row));
      if (items.length >= limit) {
        cutAt = row;
        break;
      }
    }
    // Resume after the last row returned on a full page, else after the last
    // row scanned when the scan was full. A short scan reached the end.
    const resume = cutAt ?? (rows.length === FEED_SCAN ? rows[rows.length - 1]! : null);
    const nextBefore = resume
      ? encodeCursor({ createdAt: resume.createdAt, creationTime: resume._creationTime })
      : null;
    return { items, nextBefore };
  },
});

/**
 * Newest revisions of observed entries ("context change history") with the
 * run that made each, plus the newest context-manager runs.
 */
export const listContextChanges = query({
  args: { workspaceId: v.id("workspaces"), limit: v.optional(v.number()) },
  returns: v.object({
    changes: v.array(revisionValidator),
    runs: v.array(runValidator),
  }),
  handler: async (ctx, { workspaceId, limit: requested }) => {
    await requireMembership(ctx, workspaceId);
    const limit = Math.min(CHANGES_MAX, Math.max(1, Math.floor(requested ?? CHANGES_DEFAULT)));
    const revisions = await ctx.db
      .query("context_entry_revisions")
      .withIndex("by_workspace_and_created", (q) => q.eq("workspaceId", workspaceId))
      .order("desc")
      .take(limit);
    const runCache = new Map<Id<"context_intel_runs">, Doc<"context_intel_runs"> | null>();
    const changes = [];
    for (const revision of revisions) changes.push(await toRevision(ctx, revision, runCache));
    const runs = await ctx.db
      .query("context_intel_runs")
      .withIndex("by_workspace_and_started_at", (q) => q.eq("workspaceId", workspaceId))
      .order("desc")
      .take(RUNS_LIMIT);
    return {
      changes,
      runs: runs.map((run) => ({
        id: run._id,
        status: run.status,
        method: run.method,
        model: run.model ?? null,
        summary: run.summary ?? null,
        error: run.error ?? null,
        eventCount: run.eventIds.length,
        proposals: run.proposals,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt ?? null,
      })),
    };
  },
});

async function toRevision(
  ctx: ReadCtx,
  revision: Doc<"context_entry_revisions">,
  runCache: Map<Id<"context_intel_runs">, Doc<"context_intel_runs"> | null>,
): Promise<typeof revisionValidator.type> {
  let run: Doc<"context_intel_runs"> | null = null;
  if (revision.runId) {
    if (!runCache.has(revision.runId)) runCache.set(revision.runId, await ctx.db.get(revision.runId));
    run = runCache.get(revision.runId) ?? null;
    if (run && run.workspaceId !== revision.workspaceId) run = null;
  }
  const firstEvidence = revision.evidenceEventIds[0]
    ? await ctx.db.get(revision.evidenceEventIds[0])
    : null;
  return {
    id: revision._id,
    entryId: revision.entryId,
    key: revision.key,
    category: revision.category,
    revision: revision.revision,
    change: revision.change,
    title: revision.title,
    content: revision.content,
    status: revision.status,
    evidence: revision.evidence,
    confidence: revision.confidence,
    reason: revision.reason,
    evidenceCount: revision.evidenceEventIds.length,
    actor: revision.actor,
    run: run ? toRunRef(run) : null,
    evidenceSource:
      firstEvidence && firstEvidence.workspaceId === revision.workspaceId
        ? { label: firstEvidence.actor.label, source: firstEvidence.source }
        : null,
    createdAt: revision.createdAt,
  };
}

async function requireEntry(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
  entryId: Id<"context_entries">,
): Promise<Doc<"context_entries">> {
  const entry = await ctx.db.get(entryId);
  // Another workspace's entry reads exactly like a missing one.
  if (!entry || entry.workspaceId !== workspaceId)
    throw new ConvexError({ code: "INVALID_INPUT", field: "entryId" });
  return entry;
}

/** One entry's provenance: every revision (newest first) and the events behind it. */
export const getEntryHistory = query({
  args: { workspaceId: v.id("workspaces"), entryId: v.id("context_entries") },
  returns: v.object({
    entry: entryValidator,
    revisions: v.array(revisionValidator),
    evidence: v.array(activityEventValidator),
  }),
  handler: async (ctx, { workspaceId, entryId }) => {
    await requireMembership(ctx, workspaceId);
    const entry = await requireEntry(ctx, workspaceId, entryId);
    const rows = await ctx.db
      .query("context_entry_revisions")
      .withIndex("by_entry_and_revision", (q) => q.eq("entryId", entryId))
      .order("desc")
      .take(HISTORY_LIMIT);
    const runCache = new Map<Id<"context_intel_runs">, Doc<"context_intel_runs"> | null>();
    const revisions = [];
    for (const row of rows) revisions.push(await toRevision(ctx, row, runCache));
    // The entry's current evidence first, then what earlier revisions cited.
    const ids = new Set<Id<"activity_events">>();
    for (const id of entry.evidenceEventIds) ids.add(id);
    for (const row of rows) for (const id of row.evidenceEventIds) ids.add(id);
    const evidence = [];
    for (const id of [...ids].slice(0, EVIDENCE_LIMIT)) {
      const event = await ctx.db.get(id);
      if (event?.workspaceId === workspaceId) evidence.push(toEvent(event));
    }
    evidence.sort((a, b) => b.createdAt - a.createdAt);
    return {
      entry: await toEntry(ctx, entry, agentResolver(ctx, workspaceId)),
      revisions,
      evidence,
    };
  },
});

function clampText(value: string, max: number, field: string): string {
  const text = value.trim();
  if (!text || text.length > max) throw new ConvexError({ code: "INVALID_INPUT", field });
  return text;
}

/**
 * A person's correction of an observed entry: a new revision ("corrected"),
 * attributed to them. Setting the status counts as confirming it
 * (human_confirmed). Bumps entriesRevision so a context-manager batch that
 * loaded the old state goes stale and retries against this one.
 */
async function applyCorrection(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    entryId: Id<"context_entries">;
    expectedRevision: number;
    title?: string;
    content?: string;
    status?: Doc<"context_entries">["status"];
    note: string;
  },
) {
  const { user } = await requireMembership(ctx, args.workspaceId);
  const entry = await requireEntry(ctx, args.workspaceId, args.entryId);
  if (entry.revision !== args.expectedRevision)
    throw new ConvexError({ code: "VERSION_CONFLICT", currentRevision: entry.revision });
  const note = clampText(args.note, MAX_NOTE, "note");
  const title = args.title === undefined ? entry.title : clampText(args.title, MAX_TITLE, "title");
  const content =
    args.content === undefined ? entry.content : clampText(args.content, MAX_CONTENT, "content");
  const status = args.status ?? entry.status;
  const confirmed = args.status !== undefined;
  const evidence = confirmed ? "human_confirmed" : entry.evidence;
  const confidence = confirmed ? 1 : entry.confidence;
  const actor = humanActor(user);
  const now = Date.now();
  const revision = entry.revision + 1;
  await ctx.db.patch(entry._id, {
    title,
    content,
    status,
    evidence,
    confidence,
    updatedBy: actor,
    revision,
    updatedAt: now,
  });
  await ctx.db.insert("context_entry_revisions", {
    workspaceId: args.workspaceId,
    entryId: entry._id,
    key: entry.key,
    revision,
    change: "corrected",
    category: entry.category,
    title,
    content,
    status,
    evidence,
    confidence,
    reason: note,
    evidenceEventIds: entry.evidenceEventIds,
    actor,
    createdAt: now,
  });
  const state = await intelState(ctx, args.workspaceId);
  let entriesRevision: number;
  if (state) {
    entriesRevision = state.entriesRevision + 1;
    await ctx.db.patch(state._id, { entriesRevision, updatedAt: now });
  } else {
    entriesRevision = 1;
    await ctx.db.insert("context_intel_state", {
      workspaceId: args.workspaceId,
      status: "idle",
      consecutiveFailures: 0,
      entriesRevision,
      updatedAt: now,
    });
  }
  const verb = status === "retracted" && entry.status !== "retracted" ? "Retracted" : "Corrected";
  await recordWorkspaceEvent(ctx, {
    workspaceId: args.workspaceId,
    kind: "context.corrected",
    entityType: "context_entry",
    entityId: entry._id,
    summary: `${verb} observed ${entry.category.replace("_", " ")}: ${title.slice(0, 80)}`,
    actor,
  });
  return { revision, entriesRevision };
}

const correctionResult = v.object({ revision: v.number(), entriesRevision: v.number() });

/** Edit, confirm or change the status of an observed entry. Any member. */
export const correctEntry = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    entryId: v.id("context_entries"),
    expectedRevision: v.number(),
    title: v.optional(v.string()),
    content: v.optional(v.string()),
    status: v.optional(statusValidator),
    note: v.string(),
  },
  returns: correctionResult,
  handler: async (ctx, args) => await applyCorrection(ctx, args),
});

/** Marks an observed entry wrong (status retracted). Any member. */
export const retractEntry = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    entryId: v.id("context_entries"),
    expectedRevision: v.number(),
    note: v.optional(v.string()),
  },
  returns: correctionResult,
  handler: async (ctx, args) =>
    await applyCorrection(ctx, {
      ...args,
      status: "retracted",
      note: args.note?.trim() || "Retracted by a person",
    }),
});

/**
 * Owner/admin: clears the failure backoff and runs the context manager now.
 * A batch that holds a live lease is left alone; it re-checks for pending
 * events when it finishes.
 */
export const retryContextManager = mutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ scheduled: v.boolean() }),
  handler: async (ctx, { workspaceId }) => {
    const { membership } = await requireMembership(ctx, workspaceId);
    if (membership.role !== "owner" && membership.role !== "admin")
      throw new ConvexError({ code: "FORBIDDEN" });
    const now = Date.now();
    const state = await intelState(ctx, workspaceId);
    const running = state?.status === "running" && (state.leaseExpiresAt ?? 0) > now;
    const schedule = !running && !intelDisabled();
    if (schedule) await ctx.scheduler.runAfter(0, internal.intel.processWorkspace, { workspaceId });
    if (state) {
      await ctx.db.patch(state._id, {
        consecutiveFailures: 0,
        nextRetryAt: undefined,
        ...(schedule ? { status: "scheduled" as const, scheduledFor: now } : {}),
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("context_intel_state", {
        workspaceId,
        status: schedule ? "scheduled" : "idle",
        ...(schedule ? { scheduledFor: now } : {}),
        consecutiveFailures: 0,
        entriesRevision: 0,
        updatedAt: now,
      });
    }
    return { scheduled: schedule };
  },
});
