import { folderHref } from "./folders";
import type { ActivityKind, AgentNetwork, NetworkAgent, TimelineItem } from "./api/types";

const MINUTE = 60_000;
/** Under this since the last MCP action reads "Called a tool just now". */
export const ACTIVE_NOW_MS = 2 * MINUTE;
/** Under this reads "Recently active"; older is "Idle". */
export const RECENTLY_ACTIVE_MS = 30 * MINUTE;

export type AgentStatus = "active" | "recent" | "idle" | "none";

/**
 * From timestamps only. Each MCP call is one atomic mutation, so Tandem never
 * sees work in progress, and it can't tell whether a chat is open: no
 * "online" and no "processing".
 */
export function agentStatus(agent: Pick<NetworkAgent, "lastMcpActionAt" | "lastSyncAt">, now: number): AgentStatus {
  const at = Math.max(agent.lastMcpActionAt ?? -Infinity, agent.lastSyncAt ?? -Infinity);
  if (!Number.isFinite(at)) return "none";
  const age = now - at;
  if (age < ACTIVE_NOW_MS) return "active";
  if (age < RECENTLY_ACTIVE_MS) return "recent";
  return "idle";
}

export const STATUS_LABEL: Record<AgentStatus, string> = {
  active: "Called a tool just now",
  recent: "Recently active",
  idle: "Idle",
  none: "No activity yet",
};

export type Propagation =
  | { state: "current"; label: string }
  | { state: "behind"; label: string; behind: number }
  | { state: "never"; label: string };

/** Whether the assistant has received the latest approved context through sync_workspace. */
export function propagation(agent: Pick<NetworkAgent, "syncedContextRevision" | "contextVersionsBehind">): Propagation {
  if (agent.syncedContextRevision === null) return { state: "never", label: "Never synchronized" };
  const behind = Math.max(0, agent.contextVersionsBehind ?? 0);
  if (behind === 0) return { state: "current", label: "Up to date" };
  return { state: "behind", behind, label: `Behind by ${behind} ${behind === 1 ? "version" : "versions"}` };
}

/**
 * The page's one-line answer: how many assistants have received the current
 * context, naming the ones that haven't.
 */
export function networkHeadline(network: AgentNetwork): string {
  const { agents, contextRevision } = network;
  if (agents.length === 0) return "No assistants have connected to this workspace yet.";
  const assistants = agents.length === 1 ? "assistant" : "assistants";
  if (contextRevision === 0) return `${agents.length} ${assistants} connected. No project context has been approved yet.`;
  const lagging = agents.filter((agent) => propagation(agent).state !== "current");
  if (lagging.length === 0)
    return agents.length === 1
      ? `The connected assistant has received context v${contextRevision}.`
      : `All ${agents.length} ${assistants} have received context v${contextRevision}.`;
  const received = agents.length - lagging.length;
  return `${received} of ${agents.length} ${assistants} have received context v${contextRevision}.`;
}

/** Which way a pulse travels on the agent's edge: Tandem → assistant, assistant → Tandem, or a flash. */
export type Flow = "in" | "out" | "conflict" | "error" | "human";

export interface KindMeta {
  label: string;
  flow: Flow;
}

export const KIND_META: Record<ActivityKind, KindMeta> = {
  sync: { label: "Sync", flow: "in" },
  read: { label: "Read", flow: "in" },
  write: { label: "Write", flow: "out" },
  propose: { label: "Proposal", flow: "out" },
  publish: { label: "Published", flow: "out" },
  task: { label: "Task", flow: "out" },
  resolved: { label: "Resolved", flow: "out" },
  conflict: { label: "Conflict", flow: "conflict" },
  error: { label: "Error", flow: "error" },
  approve: { label: "Approved", flow: "human" },
  reject: { label: "Rejected", flow: "human" },
  context: { label: "Context edit", flow: "human" },
  human_edit: { label: "Edit", flow: "human" },
};

export type FilterGroup = "all" | "sync" | "reads" | "writes" | "decisions" | "conflicts";

/** Timeline type filters; the kinds go to the backend, which filters server-side. */
export const FILTER_GROUPS: ReadonlyArray<{ value: FilterGroup; label: string; title: string; kinds: ActivityKind[] }> = [
  { value: "all", label: "All", title: "Everything", kinds: [] },
  { value: "sync", label: "Sync", title: "sync_workspace calls", kinds: ["sync"] },
  { value: "reads", label: "Reads", title: "Reads and searches", kinds: ["read"] },
  {
    value: "writes",
    label: "Writes",
    title: "Saves, published work, tasks and people's edits",
    kinds: ["write", "resolved", "publish", "task", "human_edit"],
  },
  {
    value: "decisions",
    label: "Proposals",
    title: "Proposals and approvals",
    kinds: ["propose", "approve", "reject", "context"],
  },
  { value: "conflicts", label: "Conflicts", title: "Conflicts, errors and their fixes", kinds: ["conflict", "error", "resolved"] },
];

export function kindsFor(group: FilterGroup): ActivityKind[] {
  return FILTER_GROUPS.find((g) => g.value === group)?.kinds ?? [];
}

/** Where a timeline item's resource lives in the dashboard, or null when it has no page. */
export function resourceHref(workspaceId: string, resource: TimelineItem["resource"]): string | null {
  if (!resource) return null;
  const base = `/w/${workspaceId}`;
  switch (resource.type) {
    case "file":
      return `${base}/files/${resource.id}`;
    case "folder":
      return folderHref(workspaceId, resource.id);
    case "proposal":
      return `${base}/approvals`;
    case "context":
    case "published_work": // listed on the context page
      return `${base}/context`;
    default:
      return null;
  }
}

/**
 * Items in `next` that `seen` doesn't hold yet, oldest first, so pulses play
 * in the order the calls happened. `seen` is updated in place.
 */
export function takeArrivals(seen: Set<string>, next: readonly TimelineItem[]): TimelineItem[] {
  const fresh = next.filter((item) => !seen.has(item.id));
  for (const item of next) seen.add(item.id);
  return fresh.reverse();
}

/**
 * Merges a fresh head page into what's already loaded (newest first, by id):
 * items that scrolled off the head page stay, so older pages never leave a gap.
 */
export function mergeTimeline(loaded: readonly TimelineItem[], incoming: readonly TimelineItem[]): TimelineItem[] {
  const byId = new Map<string, TimelineItem>();
  for (const item of loaded) byId.set(item.id, item);
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
}

/** Evenly spaced points on an ellipse around the origin, clockwise from `start` (radians; default the top). */
export function ringPositions(count: number, rx: number, ry: number, start = -Math.PI / 2): Array<{ x: number; y: number }> {
  return Array.from({ length: count }, (_, i) => {
    const angle = start + (2 * Math.PI * i) / Math.max(1, count);
    return { x: Math.cos(angle) * rx, y: Math.sin(angle) * ry };
  });
}
