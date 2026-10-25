// The context manager's derived state (context_entries), as sync_workspace
// hands it to assistants (docs/context-intelligence.md "Consumption"). It is
// observed, not approved: only structured_context is authoritative, so every
// result carries OBSERVED_NOTE. Reads are bounded; brief mode keeps the few
// entries an assistant should see first.
import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { agentActor } from "./agent";

type ReadCtx = QueryCtx | MutationCtx;

export const OBSERVED_NOTE =
  "Observed by Tandem's context manager from assistant and workspace activity. " +
  "Not approved context: only `context` (and brief active_decisions) is authoritative. " +
  "evidence: requested < claimed < observed < verified < human_confirmed; treat claimed as unconfirmed.";

/** Active, completed and resolved entries in a full sync. */
export const OBSERVED_LIMIT = 60;
/** Superseded entries, full sync only: what changed recently, not current state. */
export const OBSERVED_SUPERSEDED_LIMIT = 10;
/** Entries in the sync brief. */
export const OBSERVED_BRIEF_LIMIT = 12;
/** Brief content is clipped to this many characters. */
export const OBSERVED_BRIEF_CONTENT = 200;
// Newest rows scanned at most; retracted and over-cap rows are skipped.
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
  status: v.union(
    v.literal("active"),
    v.literal("completed"),
    v.literal("resolved"),
    v.literal("superseded"),
  ),
  evidence: v.union(
    v.literal("requested"),
    v.literal("claimed"),
    v.literal("observed"),
    v.literal("verified"),
    v.literal("human_confirmed"),
  ),
  confidence: v.number(),
  agents: v.array(
    v.object({
      agentConnectionId: v.id("agent_connections"),
      label: v.string(),
      client: v.string(),
      userName: v.string(),
    }),
  ),
  fileIds: v.array(v.id("files")),
  evidenceCount: v.number(),
  updatedAt: v.number(),
  supersededBy: v.union(v.string(), v.null()),
  proposalId: v.union(v.id("context_proposals"), v.null()),
});

export const observedValidator = v.object({
  /** context_intel_state.entriesRevision; 0 before the first applied run. */
  revision: v.number(),
  updatedAt: v.union(v.number(), v.null()),
  lastRunAt: v.union(v.number(), v.null()),
  entries: v.array(observedEntryValidator),
  /** More entries existed than the cap allowed. */
  truncated: v.boolean(),
});

export type ObservedEntry = Infer<typeof observedEntryValidator>;
export type Observed = Infer<typeof observedValidator>;

/** Lower ranks come first in the brief. */
function briefRank(e: ObservedEntry): number {
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
      return 5;
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The brief's selection from a full observed result: no superseded entries,
 * open blockers, then active tasks and progress, agent summaries,
 * coordination, decisions/goals/objectives, knowledge, then finished work;
 * newest first within each rank. Content is clipped.
 */
export function briefObserved(full: Observed): Observed {
  const current = full.entries.filter((e) => e.status !== "superseded");
  const ranked = current
    .map((e, i) => ({ e, i, rank: briefRank(e) }))
    // Entries arrive newest first, so the index breaks ties by recency.
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(({ e }) => e);
  return {
    ...full,
    entries: ranked
      .slice(0, OBSERVED_BRIEF_LIMIT)
      .map((e) => ({ ...e, content: clip(e.content, OBSERVED_BRIEF_CONTENT) })),
    truncated: full.truncated || ranked.length > OBSERVED_BRIEF_LIMIT,
  };
}

/**
 * The workspace's observed state, newest first. Retracted entries never
 * appear; superseded ones only in full mode. Agents are labeled from their
 * connection rows in this workspace only.
 */
export async function loadObservedContext(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
  { brief }: { brief: boolean },
): Promise<Observed> {
  const state = await ctx.db
    .query("context_intel_state")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  const current: Doc<"context_entries">[] = [];
  const superseded: Doc<"context_entries">[] = [];
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
    if (entry.status === "retracted") continue;
    const bucket = entry.status === "superseded" ? superseded : current;
    const cap = entry.status === "superseded" ? OBSERVED_SUPERSEDED_LIMIT : OBSERVED_LIMIT;
    if (bucket.length < cap) bucket.push(entry);
    else if (entry.status !== "superseded") {
      truncated = true;
      if (superseded.length >= OBSERVED_SUPERSEDED_LIMIT) break;
    }
  }
  const agents = new Map<string, ObservedEntry["agents"][number] | null>();
  const labelAgent = async (id: Id<"agent_connections">) => {
    if (agents.has(id)) return agents.get(id) ?? null;
    const connection = await ctx.db.get(id);
    const user = connection ? await ctx.db.get(connection.userId) : null;
    let agent: ObservedEntry["agents"][number] | null = null;
    if (connection && user && connection.workspaceId === workspaceId) {
      const actor = agentActor(connection, user);
      agent = {
        agentConnectionId: id,
        label: actor.label,
        client: connection.client,
        userName: actor.userName ?? "Workspace member",
      };
    }
    agents.set(id, agent);
    return agent;
  };
  const toEntry = async (e: Doc<"context_entries">): Promise<ObservedEntry> => {
    const labeled = [];
    for (const id of e.agentConnectionIds) {
      const agent = await labelAgent(id);
      if (agent) labeled.push(agent);
    }
    return {
      key: e.key,
      category: e.category,
      title: e.title,
      content: e.content,
      // Retracted rows were skipped above.
      status: e.status as ObservedEntry["status"],
      evidence: e.evidence,
      confidence: Math.round(e.confidence * 100) / 100,
      agents: labeled,
      fileIds: e.fileIds,
      evidenceCount: e.evidenceEventIds.length,
      updatedAt: e.updatedAt,
      supersededBy: e.supersededBy ?? null,
      proposalId: e.proposalId ?? null,
    };
  };
  const full: Observed = {
    revision: state?.entriesRevision ?? 0,
    updatedAt: newest,
    lastRunAt: state?.lastRunAt ?? null,
    entries: await Promise.all(
      [...current, ...superseded].sort((a, b) => b.updatedAt - a.updatedAt).map(toEntry),
    ),
    truncated,
  };
  return brief ? briefObserved(full) : full;
}
