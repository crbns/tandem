import type { AgentActivity, ContextDetails, ContextEntry, ContextField, FileSummary, FolderSummary } from "./api/types";
import { contextSections } from "./context";
import { treeOrder } from "./folders";

/** How recently Tandem must have heard from an assistant to count it as recently active. */
export const RECENT_ACTIVITY_MS = 15 * 60_000;

export interface AgentSummary {
  /** Unrevoked connections; says nothing about whether they're running. */
  connected: number;
  /** Connections with an MCP action or sync within `RECENT_ACTIVITY_MS`. */
  recentlyActive: number;
  /** The latest MCP action or sync across every connection, or null if never. */
  lastHeardAt: number | null;
  /** Connections per client, most first. */
  byClient: { client: string; count: number }[];
}

function lastHeard(activity: AgentActivity): number | null {
  const at = Math.max(activity.lastMcpActionAt ?? -Infinity, activity.lastSyncAt ?? -Infinity);
  return Number.isFinite(at) ? at : null;
}

export function summarizeAgents(activity: readonly AgentActivity[], now: number): AgentSummary {
  const counts = new Map<string, number>();
  let recentlyActive = 0;
  let lastHeardAt: number | null = null;
  for (const connection of activity) {
    counts.set(connection.client, (counts.get(connection.client) ?? 0) + 1);
    const at = lastHeard(connection);
    if (at === null) continue;
    if (now - at <= RECENT_ACTIVITY_MS) recentlyActive++;
    if (lastHeardAt === null || at > lastHeardAt) lastHeardAt = at;
  }
  return {
    connected: activity.length,
    recentlyActive,
    lastHeardAt,
    byClient: [...counts]
      .map(([client, count]) => ({ client, count }))
      .sort((a, b) => b.count - a.count || a.client.localeCompare(b.client)),
  };
}

export type TreeRow =
  | { kind: "folder"; folder: FolderSummary; depth: number; fileCount: number }
  | { kind: "file"; file: FileSummary };

export interface CondensedTree {
  rows: TreeRow[];
  /** Rows left out to keep the view short. */
  hidden: number;
}

/**
 * The workspace tree at a glance: folders down to `maxDepth` (deeper ones are
 * counted in their ancestor's file count), then the root's files, newest
 * first, cut at `maxRows`.
 */
export function condenseTree(
  folders: readonly FolderSummary[],
  files: readonly FileSummary[],
  { maxDepth = 2, maxRows = 10 }: { maxDepth?: number; maxRows?: number } = {},
): CondensedTree {
  const ordered = treeOrder(folders);
  const parentOf = new Map(folders.map((folder) => [folder.id, folder.parentId]));
  const subtreeFiles = new Map<string, number>();
  for (const file of files) {
    const seen = new Set<string>();
    for (let id = file.parentId; id !== null && !seen.has(id); id = parentOf.get(id) ?? null) {
      seen.add(id);
      subtreeFiles.set(id, (subtreeFiles.get(id) ?? 0) + 1);
    }
  }
  const rows: TreeRow[] = [
    ...ordered
      .filter(({ depth }) => depth <= maxDepth)
      .map(({ folder, depth }): TreeRow => ({ kind: "folder", folder, depth, fileCount: subtreeFiles.get(folder.id) ?? 0 })),
    ...files
      .filter((file) => file.parentId === null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((file): TreeRow => ({ kind: "file", file })),
  ];
  return { rows: rows.slice(0, maxRows), hidden: Math.max(0, rows.length - maxRows) };
}

/** The most recently changed files anywhere in the workspace. */
export function recentFiles(files: readonly FileSummary[], limit = 5): FileSummary[] {
  return [...files].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

export interface ContextDigestSection {
  field: ContextField;
  label: string;
  /** Active entries only: resolved and superseded ones are history. */
  entries: ContextEntry[];
}

/** Each context section's active entries, in the context page's order. */
export function contextDigest(context: ContextDetails): ContextDigestSection[] {
  return contextSections(context).map(({ field, label, entries }) => ({
    field,
    label,
    entries: entries.filter((entry) => entry.status === "active"),
  }));
}
