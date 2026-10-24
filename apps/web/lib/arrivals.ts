import { actorLabel } from "./actors";
import type { FileSummary } from "./api/types";

/** A file an assistant created, saved, or renamed/moved since the dashboard last looked. */
export interface Arrival {
  kind: "created" | "updated" | "moved";
  file: FileSummary;
}

/** How long an arrived row stays marked in the file list. */
export const ARRIVAL_MS = 8000;

/** A marked file: the version that arrived, and when the dashboard noticed it. */
export interface ArrivalMark {
  version: number;
  at: number;
}

/**
 * The CSS animation-delay (ms, zero or negative) that puts an arrival's fade
 * where it should be at `now`, so a list that mounts late doesn't replay it.
 */
export function arrivalDelay(at: number, now: number): number {
  return Math.max(-ARRIVAL_MS, Math.min(0, at - now));
}

/**
 * Compares two listings of the same workspace. Only agent writes count: a
 * person saw their own edit, and the point is noticing what an assistant did
 * from a native chat. `previous` null is the first load, which reports nothing.
 */
export function detectArrivals(previous: FileSummary[] | null, next: FileSummary[]): Arrival[] {
  if (previous === null) return [];
  const seen = new Map(previous.map((f) => [f.id, f]));
  const arrivals: Arrival[] = [];
  for (const file of next) {
    if (file.updatedBy.actorType !== "agent") continue;
    const before = seen.get(file.id);
    if (before === undefined) arrivals.push({ kind: "created", file });
    else if (file.version > before.version)
      // A rename or move bumps the version too; content edits never change these.
      arrivals.push({
        kind: file.name !== before.name || file.parentId !== before.parentId ? "moved" : "updated",
        file,
      });
  }
  return arrivals;
}

/** "Alex via Claude created proposal.md", "… saved brief.md v3", "… moved notes.md". */
export function arrivalMessage({ kind, file }: Arrival): string {
  const who = actorLabel(file.updatedBy);
  if (kind === "created") return `${who} created ${file.name}`;
  if (kind === "moved") return `${who} moved ${file.name}`;
  return `${who} saved ${file.name} v${file.version}`;
}
