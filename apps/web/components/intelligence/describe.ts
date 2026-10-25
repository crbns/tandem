import {
  BookOpenIcon,
  CirclePlayIcon,
  CircleStopIcon,
  FileTextIcon,
  FlaskConicalIcon,
  MessageSquareTextIcon,
  OctagonAlertIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import type {
  ActivityEvent,
  ActivitySource,
  ContextChange,
  EvidenceLevel,
  ObservedCategory,
  ObservedEntry,
} from "@/lib/api/types";

/** The observed-state panel's sections, in reading order. */
export type GroupKey =
  | "goals"
  | "decisions"
  | "in_progress"
  | "completed"
  | "blocked"
  | "knowledge"
  | "assistants"
  | "coordination";

export const GROUPS: ReadonlyArray<{ key: GroupKey; label: string; empty: string }> = [
  { key: "goals", label: "Goal & objectives", empty: "No goal or objectives observed yet." },
  { key: "in_progress", label: "In progress", empty: "Nothing observed in progress." },
  { key: "blocked", label: "Blocked", empty: "No blockers observed." },
  { key: "completed", label: "Completed", empty: "Nothing observed as finished yet." },
  { key: "decisions", label: "Decisions", empty: "No decisions observed." },
  { key: "coordination", label: "Coordination", empty: "No overlaps or conflicts observed." },
  { key: "assistants", label: "Assistants", empty: "No assistant summaries yet." },
  { key: "knowledge", label: "Knowledge", empty: "No findings recorded yet." },
];

/** Retracted and superseded entries are history, not current state. */
export function isCurrent(entry: Pick<ObservedEntry, "status">): boolean {
  return entry.status !== "retracted" && entry.status !== "superseded";
}

/** Which section an entry belongs in; resolved blockers count as done. */
export function groupOf(entry: Pick<ObservedEntry, "category" | "status">): GroupKey {
  switch (entry.category) {
    case "goal":
    case "objective":
      return "goals";
    case "decision":
      return "decisions";
    case "blocker":
      return entry.status === "active" ? "blocked" : "completed";
    case "knowledge":
      return "knowledge";
    case "agent_summary":
      return "assistants";
    case "coordination":
      return "coordination";
    case "task":
    case "progress":
      return entry.status === "completed" || entry.status === "resolved" ? "completed" : "in_progress";
  }
}

/** Current entries by section, each newest first. */
export function groupEntries(entries: readonly ObservedEntry[]): Map<GroupKey, ObservedEntry[]> {
  const groups = new Map<GroupKey, ObservedEntry[]>(GROUPS.map((g) => [g.key, []]));
  for (const entry of entries) if (isCurrent(entry)) groups.get(groupOf(entry))!.push(entry);
  for (const list of groups.values()) list.sort((a, b) => b.updatedAt - a.updatedAt);
  return groups;
}

export const CATEGORY_NOUN: Record<ObservedCategory, string> = {
  goal: "goal",
  objective: "objective",
  decision: "decision",
  task: "task",
  progress: "progress note",
  blocker: "blocker",
  knowledge: "finding",
  agent_summary: "assistant summary",
  coordination: "coordination note",
};

/**
 * The evidence ladder, weakest first. Claimed is amber: an assistant said so
 * and nothing checked it. Verified (a passing test/build or a person) is green.
 */
export const EVIDENCE_META: Record<EvidenceLevel, { label: string; title: string; className: string }> = {
  requested: {
    label: "Requested",
    title: "Someone asked for this; nothing shows it started.",
    className: "border-border text-muted-foreground",
  },
  claimed: {
    label: "Claimed · unconfirmed",
    title: "An assistant said so; nothing has verified it.",
    className: "border-warn-rule bg-warn-tint text-warn",
  },
  observed: {
    label: "Observed",
    title: "Seen in recorded activity (tool calls, file changes, hooks).",
    className: "border-archive/30 bg-archive-tint text-archive",
  },
  verified: {
    label: "Verified",
    title: "Backed by a passing check, such as a successful test or build.",
    className: "border-agent/40 bg-agent-tint text-agent",
  },
  human_confirmed: {
    label: "Confirmed by a person",
    title: "A workspace member confirmed or corrected it.",
    className: "border-human/40 bg-human-tint text-human",
  },
};

export const SOURCE_META: Record<ActivitySource, { label: string; className: string }> = {
  mcp: { label: "MCP", className: "border-archive/30 bg-archive-tint text-archive" },
  claude_code: { label: "Claude Code", className: "border-agent/40 bg-agent-tint text-agent" },
  workspace: { label: "Workspace", className: "border-human/40 bg-human-tint text-human" },
  // Always unmistakable: development replay, not real work.
  simulator: { label: "Simulated", className: "border-dashed border-warn text-warn bg-transparent" },
};

export const SOURCE_FILTERS: ReadonlyArray<{ value: "all" | ActivitySource; label: string }> = [
  { value: "all", label: "All sources" },
  { value: "mcp", label: "MCP" },
  { value: "claude_code", label: "Claude Code" },
  { value: "workspace", label: "Workspace" },
  { value: "simulator", label: "Simulated" },
];

/** A type icon and short label for an activity event. */
export function eventKind(event: Pick<ActivityEvent, "type" | "tool" | "summary">): { icon: LucideIcon; label: string } {
  const { type, tool } = event;
  if (type.endsWith(".prompt")) return { icon: MessageSquareTextIcon, label: "Prompt" };
  if (type.endsWith(".session_start")) return { icon: CirclePlayIcon, label: "Session started" };
  if (type.endsWith(".stop")) return { icon: CircleStopIcon, label: "Session finished" };
  if (type.endsWith(".tool_failure")) return { icon: OctagonAlertIcon, label: "Tool failed" };
  if (type.startsWith("file.")) return { icon: FileTextIcon, label: `File ${type.slice(5)}` };
  if (type.startsWith("context.")) return { icon: BookOpenIcon, label: "Context" };
  if (tool && /^(bash|shell)$/i.test(tool) && /\b(test|vitest|jest|pytest|build|tsc)\b/i.test(event.summary))
    return { icon: FlaskConicalIcon, label: "Test run" };
  return { icon: WrenchIcon, label: tool ? "Tool call" : "Event" };
}

/** Parsed redacted payload as flat key/value rows; raw text when it isn't an object. */
export function payloadRows(payload: string | null): Array<[string, string]> {
  if (!payload) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [["payload", payload]];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [["payload", JSON.stringify(parsed)]];
  const rows: Array<[string, string]> = [];
  const visit = (prefix: string, value: unknown, depth: number) => {
    if (value && typeof value === "object" && !Array.isArray(value) && depth < 2) {
      for (const [k, v] of Object.entries(value)) visit(prefix ? `${prefix}.${k}` : k, v, depth + 1);
    } else rows.push([prefix, typeof value === "string" ? value : JSON.stringify(value)]);
  };
  visit("", parsed, 0);
  return rows;
}

/** "Sam's Claude Code activity", "simulated activity", "Alex's workspace edits". */
function fromSource(source: ContextChange["evidenceSource"]): string {
  if (!source) return "";
  if (source.source === "simulator") return " from simulated activity";
  if (source.source === "workspace") return ` from ${source.label}'s workspace changes`;
  return ` from ${source.label} activity`;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** One human-readable sentence per change in the observed-context history. */
export function describeChange(change: ContextChange): string {
  const noun = CATEGORY_NOUN[change.category];
  if (change.actor.type === "human") {
    if (change.status === "retracted") return `Retracted by ${change.actor.label}`;
    if (change.evidence === "human_confirmed" && change.change === "corrected") return `Corrected and confirmed by ${change.actor.label}`;
    return `Corrected by ${change.actor.label}`;
  }
  switch (change.change) {
    case "created":
      return `Context manager identified a new ${noun}${fromSource(change.evidenceSource)}`;
    case "status_changed":
      if (change.status === "completed")
        return change.evidence === "verified" || change.evidence === "human_confirmed"
          ? `${capitalize(noun)} marked complete (verified)`
          : `${capitalize(noun)} reported complete (unconfirmed)`;
      if (change.status === "resolved") return `${capitalize(noun)} resolved`;
      if (change.status === "retracted") return `${capitalize(noun)} retracted by the context manager`;
      if (change.status === "superseded") return `${capitalize(noun)} superseded`;
      return `${capitalize(noun)} reopened`;
    case "reopened":
      return `${capitalize(noun)} reopened`;
    case "superseded":
      return `${capitalize(noun)} superseded`;
    case "corrected":
      return `${capitalize(noun)} corrected`;
    case "updated":
      return `Context manager updated a ${noun}${fromSource(change.evidenceSource)}`;
  }
}

/** "potential overlap" vs "conflict" for coordination entries. */
export function severityLabel(severity: ObservedEntry["severity"]): string | null {
  if (severity === "actual") return "Conflict";
  if (severity === "potential") return "Potential overlap";
  return null;
}
