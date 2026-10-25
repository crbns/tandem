// The dashboard's Live view: which assistants touched the workspace, what each
// MCP call did, and whether each connection has received the latest project
// context. Rows come from agent_activity (one per MCP call, written by
// mcpTools.ts) merged with the human decisions and edits in workspace_events.
// Queries only read; recording happens in the tool mutations themselves.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, query } from "./_generated/server";
import { agentActor } from "./lib/agent";
import { requireMembership } from "./lib/auth";

const AGENT_LIMIT = 50;
const CONNECTION_SCAN = 200;
// Rows read from each source per page; filtered-out rows still count.
const TIMELINE_SCAN = 200;
const TIMELINE_DEFAULT = 50;
const TIMELINE_MAX = 100;
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 500;

const outcomeValidator = v.union(v.literal("ok"), v.literal("conflict"), v.literal("error"));

const timelineKind = v.union(
  v.literal("sync"),
  v.literal("read"),
  v.literal("write"),
  v.literal("propose"),
  v.literal("publish"),
  v.literal("task"),
  v.literal("conflict"),
  v.literal("error"),
  v.literal("resolved"),
  v.literal("approve"),
  v.literal("reject"),
  v.literal("context"),
  v.literal("human_edit"),
);
type TimelineKind = typeof timelineKind.type;

const timelineItemValidator = v.object({
  id: v.string(),
  source: v.union(v.literal("agent"), v.literal("workspace")),
  createdAt: v.number(),
  kind: timelineKind,
  tool: v.union(v.string(), v.null()),
  outcome: outcomeValidator,
  errorCode: v.union(v.string(), v.null()),
  summary: v.string(),
  actor: v.object({
    type: v.union(v.literal("human"), v.literal("agent"), v.literal("system")),
    label: v.string(),
    client: v.union(v.string(), v.null()),
    agentConnectionId: v.union(v.id("agent_connections"), v.null()),
  }),
  resource: v.union(
    v.object({ type: v.string(), id: v.string(), label: v.union(v.string(), v.null()) }),
    v.null(),
  ),
  contextRevision: v.union(v.number(), v.null()),
  previousSyncedContextRevision: v.union(v.number(), v.null()),
  resolvesId: v.union(v.string(), v.null()),
});
type TimelineItem = typeof timelineItemValidator.type;

const AGENT_KINDS = new Set<string>([
  "sync", "read", "write", "propose", "publish", "task", "conflict", "error", "resolved",
]);
const WORKSPACE_KINDS = new Set<string>(["approve", "reject", "context", "human_edit"]);

function activityKind(row: Doc<"agent_activity">): TimelineKind {
  return row.resolvesActivityId ? "resolved" : row.kind;
}

/**
 * The Live kind of a workspace event made by a person (or the system), or
 * null for events the timeline leaves out. Agent-made events are skipped by
 * the caller: their agent_activity rows already cover them.
 */
function workspaceKind(kind: string): TimelineKind | null {
  if (kind === "context.approved") return "approve";
  if (kind === "context.rejected") return "reject";
  // Context changes; the approve/reject kinds and these older kinds are
  // history from the removed proposal flow.
  if (
    kind === "context.updated" ||
    kind === "context.recorded" ||
    kind === "context.resolved" ||
    kind === "context.removed"
  )
    return "context";
  // Creates, saves (restores are saves) and moves of canonical files.
  if (kind.startsWith("file.")) return "human_edit";
  return null;
}

function workspaceResource(event: Doc<"workspace_events">): TimelineItem["resource"] {
  if (event.entityType === "file") return { type: "file", id: event.entityId, label: null };
  if (event.entityType === "context_proposal")
    return { type: "proposal", id: event.entityId, label: null };
  if (event.entityType === "structured_context")
    return { type: "context", id: event.entityId, label: null };
  return null;
}

function fromActivity(row: Doc<"agent_activity">): TimelineItem {
  return {
    id: `a:${row._id}`,
    source: "agent",
    createdAt: row.createdAt,
    kind: activityKind(row),
    tool: row.tool,
    outcome: row.outcome,
    errorCode: row.errorCode ?? null,
    summary: row.summary,
    actor: {
      type: row.actor.type,
      label: row.actor.label,
      client: row.actor.client ?? null,
      agentConnectionId: row.agentConnectionId,
    },
    resource: row.resource
      ? { type: row.resource.type, id: row.resource.id, label: row.resource.label ?? null }
      : null,
    contextRevision: row.contextRevision,
    previousSyncedContextRevision: row.previousSyncedContextRevision ?? null,
    resolvesId: row.resolvesActivityId ? `a:${row.resolvesActivityId}` : null,
  };
}

function fromEvent(event: Doc<"workspace_events">, kind: TimelineKind): TimelineItem {
  return {
    id: `w:${event._id}`,
    source: "workspace",
    createdAt: event.createdAt,
    kind,
    tool: null,
    outcome: "ok",
    errorCode: null,
    summary: event.summary,
    actor: {
      type: event.actor.type,
      label: event.actor.label,
      client: event.actor.client ?? null,
      agentConnectionId: null,
    },
    resource: workspaceResource(event),
    contextRevision: null,
    previousSyncedContextRevision: null,
    resolvesId: null,
  };
}

/**
 * Every live connection with its presence and propagation: how many project
 * context versions it has not yet received through sync_workspace. Any member sees every assistant, like listAgentActivity.
 */
export const getAgentNetwork = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({
    contextRevision: v.number(),
    contextUpdatedAt: v.union(v.number(), v.null()),
    agents: v.array(
      v.object({
        connectionId: v.id("agent_connections"),
        label: v.string(),
        client: v.string(),
        oauthClientName: v.union(v.string(), v.null()),
        lastMcpActionAt: v.union(v.number(), v.null()),
        lastSyncAt: v.union(v.number(), v.null()),
        syncedContextRevision: v.union(v.number(), v.null()),
        /** That version arrived only as a brief sync (no constraints or ownership). */
        syncedContextBrief: v.boolean(),
        contextVersionsBehind: v.union(v.number(), v.null()),
        lastTool: v.union(v.string(), v.null()),
        lastKind: v.union(v.string(), v.null()),
        lastOutcome: v.union(v.string(), v.null()),
      }),
    ),
  }),
  handler: async (ctx, { workspaceId }) => {
    await requireMembership(ctx, workspaceId);
    const context = await ctx.db
      .query("structured_context")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    const contextRevision = context?.revision ?? 0;
    const connections = await ctx.db
      .query("agent_connections")
      .withIndex("by_workspace_and_revoked_at", (q) =>
        q.eq("workspaceId", workspaceId).eq("revokedAt", undefined),
      )
      .take(CONNECTION_SCAN);
    connections.sort(
      (a, b) =>
        (b.lastMcpActionAt ?? -1) - (a.lastMcpActionAt ?? -1) || b.createdAt - a.createdAt,
    );
    const users = new Map<Id<"users">, Doc<"users"> | null>();
    const agents = [];
    for (const connection of connections.slice(0, AGENT_LIMIT)) {
      if (!users.has(connection.userId))
        users.set(connection.userId, await ctx.db.get(connection.userId));
      const user = users.get(connection.userId);
      const label = user
        ? agentActor(connection, user).label
        : (connection.displayName ?? `Workspace member's ${connection.client} assistant`);
      const last = await ctx.db
        .query("agent_activity")
        .withIndex("by_connection_and_created", (q) =>
          q.eq("agentConnectionId", connection._id),
        )
        .order("desc")
        .first();
      const synced = connection.syncedContextRevision ?? null;
      agents.push({
        connectionId: connection._id,
        label,
        client: connection.client,
        oauthClientName: connection.oauthClientName ?? null,
        lastMcpActionAt: connection.lastMcpActionAt ?? null,
        lastSyncAt: connection.lastSyncAt ?? null,
        syncedContextRevision: synced,
        syncedContextBrief: synced !== null && connection.syncedContextBrief === true,
        contextVersionsBehind: synced === null ? null : Math.max(0, contextRevision - synced),
        lastTool: last?.tool ?? null,
        lastKind: last ? activityKind(last) : null,
        lastOutcome: last?.outcome ?? null,
      });
    }
    return {
      contextRevision,
      contextUpdatedAt: context?.updatedAt ?? null,
      agents,
    };
  },
});

/** A row's place in the timeline: createdAt, then _creationTime for ties. */
interface TimelineKey {
  createdAt: number;
  creationTime: number;
}

const keyOf = (row: { createdAt: number; _creationTime: number }): TimelineKey => ({
  createdAt: row.createdAt,
  creationTime: row._creationTime,
});

/** Newest first: positive when `a` sorts after (is older than) `b`. */
const compareKeys = (a: TimelineKey, b: TimelineKey) =>
  b.createdAt - a.createdAt || b.creationTime - a.creationTime;

const encodeCursor = (key: TimelineKey) => `${key.createdAt}:${key.creationTime}`;

function decodeCursor(cursor: string): TimelineKey {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(cursor);
  const key = match && { createdAt: Number(match[1]), creationTime: Number(match[2]) };
  if (!key || !Number.isFinite(key.createdAt) || !Number.isFinite(key.creationTime))
    throw new ConvexError({ code: "INVALID_INPUT", field: "before" });
  return key;
}

/**
 * Up to TIMELINE_SCAN rows strictly older than `before`, newest first, from an
 * index ending in createdAt (and so _creationTime): first the rest of the
 * cursor's own millisecond, then everything before it. Rows sharing a
 * timestamp page apart cleanly instead of being skipped.
 */
async function scanBefore<T extends { createdAt: number; _creationTime: number }>(
  before: TimelineKey | null,
  sameMillisecond: (key: TimelineKey) => Promise<T[]>,
  older: (createdAt: number | null, take: number) => Promise<T[]>,
): Promise<T[]> {
  if (!before) return await older(null, TIMELINE_SCAN);
  const tied = await sameMillisecond(before);
  if (tied.length >= TIMELINE_SCAN) return tied;
  return [...tied, ...(await older(before.createdAt, TIMELINE_SCAN - tied.length))];
}

/**
 * Agent activity and people's decisions and edits, newest first. Pages by
 * `before`, an opaque cursor (exclusive): pass the previous page's
 * nextBefore. Each page reads at most TIMELINE_SCAN rows per source, so a
 * filtered page can be short while nextBefore is still set.
 */
export const listTimeline = query({
  args: {
    workspaceId: v.id("workspaces"),
    before: v.optional(v.string()),
    limit: v.optional(v.number()),
    connectionId: v.optional(v.id("agent_connections")),
    kinds: v.optional(v.array(v.string())),
  },
  returns: v.object({
    items: v.array(timelineItemValidator),
    nextBefore: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    await requireMembership(ctx, args.workspaceId);
    const limit = Math.min(
      TIMELINE_MAX,
      Math.max(1, Math.floor(args.limit ?? TIMELINE_DEFAULT)),
    );
    const before = args.before === undefined ? null : decodeCursor(args.before);
    const kinds = args.kinds ? new Set(args.kinds) : null;
    const wantAgent = !kinds || [...kinds].some((k) => AGENT_KINDS.has(k));
    // Workspace rows are people's and the system's, never one connection's.
    const wantWorkspace =
      args.connectionId === undefined && (!kinds || [...kinds].some((k) => WORKSPACE_KINDS.has(k)));

    let agentRows: Doc<"agent_activity">[] = [];
    if (wantAgent) {
      if (args.connectionId !== undefined) {
        const connection = await ctx.db.get(args.connectionId);
        // Another workspace's connection reads as empty, like an unknown one.
        if (connection?.workspaceId === args.workspaceId)
          agentRows = await scanBefore(
            before,
            (key) =>
              ctx.db
                .query("agent_activity")
                .withIndex("by_connection_and_created", (q) =>
                  q
                    .eq("agentConnectionId", connection._id)
                    .eq("createdAt", key.createdAt)
                    .lt("_creationTime", key.creationTime),
                )
                .order("desc")
                .take(TIMELINE_SCAN),
            (createdAt, take) =>
              ctx.db
                .query("agent_activity")
                .withIndex("by_connection_and_created", (q) => {
                  const scoped = q.eq("agentConnectionId", connection._id);
                  return createdAt === null ? scoped : scoped.lt("createdAt", createdAt);
                })
                .order("desc")
                .take(take),
          );
      } else {
        agentRows = await scanBefore(
          before,
          (key) =>
            ctx.db
              .query("agent_activity")
              .withIndex("by_workspace_and_created", (q) =>
                q
                  .eq("workspaceId", args.workspaceId)
                  .eq("createdAt", key.createdAt)
                  .lt("_creationTime", key.creationTime),
              )
              .order("desc")
              .take(TIMELINE_SCAN),
          (createdAt, take) =>
            ctx.db
              .query("agent_activity")
              .withIndex("by_workspace_and_created", (q) => {
                const scoped = q.eq("workspaceId", args.workspaceId);
                return createdAt === null ? scoped : scoped.lt("createdAt", createdAt);
              })
              .order("desc")
              .take(take),
        );
      }
    }
    const eventRows = wantWorkspace
      ? await scanBefore(
          before,
          (key) =>
            ctx.db
              .query("workspace_events")
              .withIndex("by_workspace_and_created", (q) =>
                q
                  .eq("workspaceId", args.workspaceId)
                  .eq("createdAt", key.createdAt)
                  .lt("_creationTime", key.creationTime),
              )
              .order("desc")
              .take(TIMELINE_SCAN),
          (createdAt, take) =>
            ctx.db
              .query("workspace_events")
              .withIndex("by_workspace_and_created", (q) => {
                const scoped = q.eq("workspaceId", args.workspaceId);
                return createdAt === null ? scoped : scoped.lt("createdAt", createdAt);
              })
              .order("desc")
              .take(take),
        )
      : [];

    // Past the oldest row a full source returned, that source is unread, so
    // only rows at or newer than it are complete enough to page through.
    let floor: TimelineKey | null = null;
    for (const rows of [agentRows, eventRows]) {
      if (rows.length < TIMELINE_SCAN) continue;
      const oldest = keyOf(rows[rows.length - 1]!);
      if (!floor || compareKeys(oldest, floor) < 0) floor = oldest;
    }

    const candidates: { key: TimelineKey; item: TimelineItem }[] = [];
    for (const row of agentRows) candidates.push({ key: keyOf(row), item: fromActivity(row) });
    for (const event of eventRows) {
      if (event.actor.type === "agent") continue;
      const kind = workspaceKind(event.kind);
      if (kind) candidates.push({ key: keyOf(event), item: fromEvent(event, kind) });
    }
    candidates.sort((a, b) => compareKeys(a.key, b.key));

    const items: TimelineItem[] = [];
    let last: TimelineKey | null = null;
    let cut = false;
    for (const { key, item } of candidates) {
      if (floor && compareKeys(key, floor) > 0) break;
      if (kinds && !kinds.has(item.kind)) continue;
      if (items.length >= limit) {
        cut = true;
        break;
      }
      items.push(item);
      last = key;
    }
    // Every key is unique, so resuming strictly after the last row (or the
    // floor, which is always older than `before`) neither repeats nor skips.
    const nextBefore = cut ? last! : floor;
    return { items, nextBefore: nextBefore ? encodeCursor(nextBefore) : null };
  },
});

/**
 * Daily (crons.ts): deletes agent_activity and activity_events older than 14
 * days, a batch of each per run.
 */
export const pruneActivity = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - RETENTION_MS;
    const old = await ctx.db
      .query("agent_activity")
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", cutoff))
      .take(PRUNE_BATCH);
    for (const row of old) await ctx.db.delete(row._id);
    const oldEvents = await ctx.db
      .query("activity_events")
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", cutoff))
      .take(PRUNE_BATCH);
    for (const row of oldEvents) await ctx.db.delete(row._id);
    if (old.length === PRUNE_BATCH || oldEvents.length === PRUNE_BATCH)
      await ctx.scheduler.runAfter(0, internal.activity.pruneActivity, {});
    return null;
  },
});
