// The Haiku context manager (docs/context-intelligence.md, processing rules).
// processWorkspace claims the workspace (a lease), loads one bounded batch of
// pending activity_events plus the current derived and approved context,
// asks the model once (or runs the heuristic without a key), validates the
// result deterministically (lib/intel.ts) and applies it in one mutation
// guarded by entriesRevision. Goal and decision findings only reach approved
// context as proposals, through the existing conflict detection.
import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { recordWorkspaceEvent } from "./lib/auth";
import {
  IntelParseError,
  MAX_EVENTS,
  MAX_ENTRIES,
  MAX_EVIDENCE_IDS,
  RESPONSE_SCHEMA,
  SYSTEM_PROMPT,
  changedLines,
  evidenceRank,
  extractJson,
  heuristicOutput,
  userMessage,
  validateIntelOutput,
  withDeterministic,
  type IntelBatch,
  type IntelResult,
} from "./lib/intel";
import { batchWindowMs, contextModel, INTEL_ACTOR, intelDisabled } from "./lib/intelQueue";
import { lineChanges } from "./lib/diff";
import { listProposals, loadContext, proposeContextChangeCore } from "./lib/ops";
import schema from "./schema";

declare const process: { env: Record<string, string | undefined> };

type ReadCtx = QueryCtx | MutationCtx;

const LEASE_MS = 2 * 60 * 1000;
const TIMEOUT_MS = 25_000;
const MAX_TOKENS = 4096;
const MAX_FILE_CHANGES = 5;
const MAX_CONNECTIONS = 50;
const MAX_PENDING_PROPOSALS = 20;
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
  approved: v.object({
    goal: v.union(v.string(), v.null()),
    scope: v.union(v.string(), v.null()),
    decisions: v.array(v.object({ id: v.string(), text: v.string() })),
    constraints: v.array(v.object({ id: v.string(), text: v.string() })),
  }),
  pendingProposals: v.array(v.object({ field: v.string(), text: v.string() })),
  connections: v.array(v.object({ id: v.string(), label: v.string(), client: v.string() })),
  files: v.array(v.object({ id: v.string(), name: v.string() })),
  fileChanges: v.array(
    v.object({
      fileId: v.string(),
      name: v.string(),
      version: v.number(),
      linesAdded: v.number(),
      linesRemoved: v.number(),
      added: v.array(v.string()),
      removed: v.array(v.string()),
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
});
type EntryOpArg = Infer<typeof entryOpValidator>;

const proposalOpValidator = v.object({
  field: v.union(v.literal("goal"), v.literal("decision")),
  text: v.string(),
  rationale: v.string(),
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
  const updated: { file: Doc<"files">; version?: number }[] = [];
  for (const e of args.events) {
    const fileIds: string[] = [];
    for (const r of e.resources) {
      if (r.type !== "file") continue;
      const file = await workspaceFile(r.id);
      if (file) fileIds.push(file._id);
    }
    // lib/activityLog.ts mirrors file changes as { kind, entityId, version }.
    if ((e.type === "file.updated" || e.type === "file.created") && fileIds.length > 0) {
      let version: number | undefined;
      try {
        const parsed = JSON.parse(e.payload ?? "{}") as { version?: unknown };
        if (typeof parsed.version === "number") version = parsed.version;
      } catch {
        // No version in the payload: compare the file's last two versions.
      }
      updated.push({ file: files.get(fileIds[0] as Id<"files">)!, version });
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

  // Bounded diffs: the newest version each changed or created file reached in the batch.
  const fileChanges: Batch["fileChanges"] = [];
  const seen = new Set<string>();
  for (const { file, version: given } of [...updated].reverse()) {
    if (fileChanges.length >= MAX_FILE_CHANGES || seen.has(file._id)) continue;
    seen.add(file._id);
    const version = given ?? file.version;
    const revision = (n: number) =>
      ctx.db
        .query("file_revisions")
        .withIndex("by_file_and_version", (q) => q.eq("fileId", file._id).eq("version", n))
        .first();
    const after = await revision(version);
    // A new file's first version is all additions.
    const before = version > 1 ? await revision(version - 1) : { content: "" };
    if (!after || !before) continue;
    fileChanges.push({
      fileId: file._id,
      name: file.name,
      version,
      ...lineChanges(before.content, after.content),
      ...changedLines(before.content, after.content),
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

  let approved: Batch["approved"] = { goal: null, scope: null, decisions: [], constraints: [] };
  try {
    const context = await loadContext(ctx, workspaceId);
    const active = (list: { id: string; text: string; status: string }[]) =>
      list.filter((e) => e.status === "active").map((e) => ({ id: e.id, text: e.text }));
    approved = {
      goal: context.goal?.text ?? null,
      scope: context.scope?.text ?? null,
      decisions: active(context.decisions),
      constraints: active(context.constraints),
    };
  } catch {
    // CONTEXT_NOT_INITIALIZED: nothing approved yet.
  }
  const pendingProposals = (await listProposals(ctx, workspaceId, "pending", MAX_PENDING_PROPOSALS))
    .map((p) => ({ field: p.field, text: clip(p.proposedValue, 300) }));

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
    approved,
    pendingProposals,
    connections,
    files: [...files.values()].map((f) => ({ id: f._id, name: f.name })),
    fileChanges,
  };
}

/**
 * Takes the lease (a live one held by another run wins; an expired one is
 * taken over) and returns the oldest pending events as one batch. With
 * nothing pending, records a skipped run and goes idle.
 */
export const claimBatch = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.null(), batchValidator),
  handler: async (ctx, { workspaceId }) => {
    const now = Date.now();
    const state = await getState(ctx, workspaceId);
    if (state?.status === "running" && (state.leaseExpiresAt ?? 0) > now) return null;
    if (state?.status === "running" && state.lastRunId) {
      const crashed = await ctx.db.get(state.lastRunId);
      if (crashed?.status === "running")
        await ctx.db.patch(crashed._id, { status: "failed", error: "lease expired", finishedAt: now });
    }
    const events = await pendingEvents(ctx, workspaceId, MAX_EVENTS);
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
      proposals: 0,
      startedAt: now,
    });
    if (events.length === 0) {
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
  const byPerson = existing.evidence === "human_confirmed" || existing.updatedBy.type === "human";
  if (byPerson && evidenceRank(op.evidence) <= evidenceRank(existing.evidence)) return "protected";
  const evidenceEventIds = [...new Set([...op.evidenceEventIds, ...existing.evidenceEventIds])]
    .slice(0, MAX_EVIDENCE_IDS) as Id<"activity_events">[];
  const agentConnectionIds = [...new Set([...existing.agentConnectionIds, ...op.agentConnectionIds])]
    .slice(-10) as Id<"agent_connections">[];
  const fileIds = [...new Set([...existing.fileIds, ...op.fileIds])].slice(-20) as Id<"files">[];
  const severity = op.severity ?? existing.severity;
  const supersededBy =
    op.status === "superseded" ? (op.supersededBy ?? existing.supersededBy) : undefined;
  const unchanged =
    existing.title === snapshot.title &&
    existing.content === snapshot.content &&
    existing.status === snapshot.status &&
    existing.evidence === snapshot.evidence &&
    Math.abs(existing.confidence - snapshot.confidence) < 0.005 &&
    existing.severity === severity &&
    existing.supersededBy === supersededBy &&
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
 * proposeContextChangeCore as the context manager. A nested mutation, so a
 * refusal (ALREADY_IN_CONTEXT, INVALID_INPUT) rolls back on its own and the
 * caller's apply continues.
 */
export const raiseProposal = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    field: v.union(v.literal("goal"), v.literal("decision")),
    text: v.string(),
    rationale: v.string(),
    sourceFileIds: v.array(v.id("files")),
    supersedes: v.optional(v.string()),
  },
  returns: v.object({ proposalId: v.id("context_proposals"), deduplicated: v.boolean() }),
  handler: async (ctx, args) => {
    const proposal = await proposeContextChangeCore(ctx, {
      workspaceId: args.workspaceId,
      field: args.field,
      proposedValue: args.text,
      rationale: args.rationale,
      sourceFileIds: args.sourceFileIds,
      ...(args.supersedes !== undefined ? { supersedes: args.supersedes } : {}),
      actor: INTEL_ACTOR,
    });
    return { proposalId: proposal._id, deduplicated: proposal.deduplicated };
  },
});

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
    proposals: v.array(proposalOpValidator),
    dropped: v.array(v.string()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
  },
  returns: v.object({
    stale: v.boolean(),
    created: v.number(),
    updated: v.number(),
    proposals: v.number(),
  }),
  handler: async (ctx, args) => {
    const { workspaceId } = args;
    const none = { stale: false, created: 0, updated: 0, proposals: 0 };
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

    let proposals = 0;
    for (const p of args.proposals) {
      const entry = await getEntry(ctx, workspaceId, p.key);
      // Raised before (and maybe rejected by a person): don't ask again.
      const prior = entry?.proposalId ? await ctx.db.get(entry.proposalId) : null;
      if (prior && normalize(prior.proposedValue) === normalize(p.text)) continue;
      const evidence: string[] = [];
      for (const id of p.evidenceEventIds.slice(0, 3)) {
        const e = await ctx.db.get(id);
        if (e) evidence.push(clip(e.summary, 100));
      }
      try {
        const raised: { proposalId: Id<"context_proposals">; deduplicated: boolean } =
          await ctx.runMutation(internal.intel.raiseProposal, {
            workspaceId,
            field: p.field,
            text: p.text,
            rationale: clip(
              `${p.rationale}${evidence.length ? ` Evidence: ${evidence.join("; ")}.` : ""} (Context manager, confidence ${p.confidence.toFixed(2)}.)`,
              1000,
            ),
            sourceFileIds: p.fileIds,
            ...(p.supersedes !== undefined ? { supersedes: p.supersedes } : {}),
          });
        if (entry) await ctx.db.patch(entry._id, { proposalId: raised.proposalId });
        if (!raised.deduplicated) proposals++;
      } catch {
        // ALREADY_IN_CONTEXT, INVALID_INPUT and the like: the finding stays an
        // observed entry; nothing reaches approved context.
        dropped.push(`proposal ${p.key}: not raised`);
      }
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
      proposals,
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
    return { stale: false, created, updated, proposals };
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

type Analysis = { result: IntelResult; inputTokens?: number; outputTokens?: number };

/** One Messages API call; throws with a short reason, never a provider body. */
async function askModel(key: string, model: string, batch: IntelBatch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
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
        output_config: { effort: "low", format: { type: "json_schema", schema: RESPONSE_SCHEMA } },
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage(batch) }],
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
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  try {
    body = await res.json();
  } catch {
    throw new IntelParseError();
  }
  if (body.stop_reason === "refusal") throw new Error("model refused");
  const text = (body.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  return { text, inputTokens: body.usage?.input_tokens, outputTokens: body.usage?.output_tokens };
}

async function analyze(batch: Batch): Promise<Analysis> {
  if (batch.method === "heuristic")
    return { result: validateIntelOutput(withDeterministic(heuristicOutput(batch), batch), batch) };
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("no API key");
  const reply = await askModel(key, batch.model ?? contextModel(), batch);
  const raw = extractJson(reply.text);
  if (!raw) throw new IntelParseError();
  return {
    result: validateIntelOutput(withDeterministic(raw, batch), batch),
    ...(reply.inputTokens !== undefined ? { inputTokens: reply.inputTokens } : {}),
    ...(reply.outputTokens !== undefined ? { outputTokens: reply.outputTokens } : {}),
  };
}

const KNOWN_ERRORS = /^(timeout|request failed|HTTP \d{3}|unparseable response|model refused|no API key)$/;

export const processWorkspace = internalAction({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }) => {
    if (intelDisabled()) return null;
    let batch: Batch | null = await ctx.runMutation(internal.intel.claimBatch, { workspaceId });
    if (!batch) return null;
    for (let attempt = 1; ; attempt++) {
      let analysis: Analysis;
      try {
        analysis = await analyze(batch);
      } catch (err) {
        const message = err instanceof Error ? err.message : "";
        await ctx.runMutation(internal.intel.recordFailure, {
          workspaceId,
          runId: batch.runId,
          error: KNOWN_ERRORS.test(message) ? message : "internal error",
        });
        return null;
      }
      const { result } = analysis;
      const applied: { stale: boolean } = await ctx.runMutation(internal.intel.applyResult, {
        workspaceId,
        runId: batch.runId,
        entriesRevision: batch.entriesRevision,
        eventIds: batch.events.map((e) => e.id as Id<"activity_events">),
        summary: result.summary,
        entries: result.entries as EntryOpArg[],
        proposals: result.proposals as Infer<typeof proposalOpValidator>[],
        dropped: result.dropped,
        ...(analysis.inputTokens !== undefined ? { inputTokens: analysis.inputTokens } : {}),
        ...(analysis.outputTokens !== undefined ? { outputTokens: analysis.outputTokens } : {}),
      });
      if (!applied.stale) return null;
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
