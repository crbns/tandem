// The context manager's derived state (context_entries), as sync_workspace
// hands it to assistants (docs/context-intelligence.md "Consumption"). It is
// observed, not project context: only structured_context is authoritative, so every
// result carries OBSERVED_NOTE. It is the compacted summary assistants read
// instead of skimming recent work and events, so it stays small: no
// superseded history (the dashboard shows that), labels instead of agent
// records, clipped content, and a priority order that keeps open blockers
// and active work ahead of per-document digests.
import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { agentActor } from "./agent";

type ReadCtx = QueryCtx | MutationCtx;

export const OBSERVED_NOTE =
  "Context manager's compacted summary of team activity and documents; not project context (only context is authoritative); claimed ≠ done.";

/** Entries in a full sync. */
export const OBSERVED_LIMIT = 30;
/** Full-sync content is clipped to this many characters. */
export const OBSERVED_CONTENT = 400;
/** Entries in the sync brief. */
export const OBSERVED_BRIEF_LIMIT = 10;
/** Brief content is clipped to this many characters. */
export const OBSERVED_BRIEF_CONTENT = 160;
/** Key prefix of the context manager's per-document digests. */
export const DOC_DIGEST_PREFIX = "knowledge:doc-";
/**
 * Every entriesRevision bump records one of these workspace events in the
 * same transaction (intel.ts applies a run, intelligence.ts a correction).
 * So a since-mode event page without one saw no observed change, and sync
 * leaves observed out.
 */
export const OBSERVED_EVENT_KINDS: ReadonlySet<string> = new Set(["context.observed", "context.corrected"]);
// Newest rows scanned at most; retracted and superseded rows are skipped.
const SCAN_LIMIT = 200;

export const observedEntryValidator = v.object({
  key: v.string(),
  category: v.union(
    v.literal("goal"),
    v.literal("objective"),
    v.literal("decision"),
    v.literal("task"),
    v.literal("progress"),
    v.literal("blocker"),
    v.literal("knowledge"),
    v.literal("agent_summary"),
    v.literal("coordination"),
  ),
  title: v.string(),
  content: v.string(),
  status: v.union(v.literal("active"), v.literal("completed"), v.literal("resolved")),
  evidence: v.union(
    v.literal("requested"),
    v.literal("claimed"),
    v.literal("observed"),
    v.literal("verified"),
    v.literal("human_confirmed"),
  ),
  confidence: v.number(),
  /** Assistant labels ("Sam's claude assistant"), this workspace's only. */
  agents: v.array(v.string()),
  updatedAt: v.number(),
});

export const observedValidator = v.object({
  /** context_intel_state.entriesRevision; 0 before the first applied run. */
  revision: v.number(),
  updatedAt: v.union(v.number(), v.null()),
  lastRunAt: v.union(v.number(), v.null()),
  /** Highest priority first (see rank). */
  entries: v.array(observedEntryValidator),
  /** More entries existed than the cap allowed. */
  truncated: v.boolean(),
});

export type ObservedEntry = Infer<typeof observedEntryValidator>;
export type Observed = Infer<typeof observedValidator>;

/**
 * Lower ranks come first: open blockers, active tasks and progress, agent
 * summaries, coordination, decisions/goals/objectives, other knowledge,
 * finished work, then per-document digests, which fill whatever room is left.
 */
function rank(e: { key: string; category: ObservedEntry["category"]; status: string }): number {
  const active = e.status === "active";
  switch (e.category) {
    case "blocker":
      return active ? 0 : 7;
    case "task":
    case "progress":
      return active ? 1 : 6;
    case "agent_summary":
      return 2;
    case "coordination":
      return active ? 3 : 7;
    case "decision":
    case "goal":
    case "objective":
      return 4;
    case "knowledge":
      return e.key.startsWith(DOC_DIGEST_PREFIX) ? 8 : 5;
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The brief's selection from a full observed result: its first entries, clipped. */
export function briefObserved(full: Observed): Observed {
  return {
    ...full,
    entries: full.entries
      .slice(0, OBSERVED_BRIEF_LIMIT)
      .map((e) => ({ ...e, content: clip(e.content, OBSERVED_BRIEF_CONTENT) })),
    truncated: full.truncated || full.entries.length > OBSERVED_BRIEF_LIMIT,
  };
}

/** context_intel_state.entriesRevision, 0 before the first applied run. */
export async function loadObservedRevision(ctx: ReadCtx, workspaceId: Id<"workspaces">): Promise<number> {
  const state = await ctx.db
    .query("context_intel_state")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  return state?.entriesRevision ?? 0;
}

/**
 * The workspace's current observed state: active, completed and resolved
 * entries (never retracted or superseded), at most OBSERVED_LIMIT by rank and
 * then recency, content clipped to OBSERVED_CONTENT. Agents are labeled from
 * their connection rows in this workspace only.
 */
export async function loadObservedContext(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
): Promise<Observed> {
  const state = await ctx.db
    .query("context_intel_state")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  const current: Doc<"context_entries">[] = [];
  let truncated = false;
  let newest: number | null = null;
  let scanned = 0;
  for await (const entry of ctx.db
    .query("context_entries")
    .withIndex("by_workspace_and_updated_at", (q) => q.eq("workspaceId", workspaceId))
    .order("desc")) {
    if (++scanned > SCAN_LIMIT) {
      truncated = true;
      break;
    }
    newest ??= entry.updatedAt;
    if (entry.status !== "retracted" && entry.status !== "superseded") current.push(entry);
  }
  // Rows arrive newest first, so the index breaks ties by recency.
  const selected = current
    .map((e, i) => ({ e, i, rank: rank(e) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(({ e }) => e);
  if (selected.length > OBSERVED_LIMIT) truncated = true;
  const labels = new Map<string, string | null>();
  const labelAgent = async (id: Id<"agent_connections">) => {
    if (labels.has(id)) return labels.get(id) ?? null;
    const connection = await ctx.db.get(id);
    const user = connection ? await ctx.db.get(connection.userId) : null;
    const label =
      connection && user && connection.workspaceId === workspaceId ? agentActor(connection, user).label : null;
    labels.set(id, label);
    return label;
  };
  const toEntry = async (e: Doc<"context_entries">): Promise<ObservedEntry> => {
    const agents: string[] = [];
    for (const id of e.agentConnectionIds) {
      const label = await labelAgent(id);
      if (label) agents.push(label);
    }
    return {
      key: e.key,
      category: e.category,
      title: e.title,
      content: clip(e.content, OBSERVED_CONTENT),
      // Retracted and superseded rows were skipped above.
      status: e.status as ObservedEntry["status"],
      evidence: e.evidence,
      confidence: Math.round(e.confidence * 100) / 100,
      agents,
      updatedAt: e.updatedAt,
    };
  };
  return {
    revision: state?.entriesRevision ?? 0,
    updatedAt: newest,
    lastRunAt: state?.lastRunAt ?? null,
    entries: await Promise.all(selected.slice(0, OBSERVED_LIMIT).map(toEntry)),
    truncated,
  };
}
