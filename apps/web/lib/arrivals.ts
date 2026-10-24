import { actorLabel } from "./actors";
import type { FileSummary } from "./api/types";

/** A file an assistant created or saved since the dashboard last looked. */
export interface Arrival {
  kind: "created" | "updated";
  file: FileSummary;
}

/** How long an arrived row stays marked in the file list. */
export const ARRIVAL_MS = 8000;

/**
 * Compares two listings of the same workspace. Only agent writes count: a
 * person saw their own edit, and the point is noticing what an assistant did
 * from a native chat. `previous` null is the first load, which reports nothing.
 */
export function detectArrivals(previous: FileSummary[] | null, next: FileSummary[]): Arrival[] {
  if (previous === null) return [];
  const seen = new Map(previous.map((f) => [f.id, f.version]));
  const arrivals: Arrival[] = [];
  for (const file of next) {
    if (file.updatedBy.actorType !== "agent") continue;
    const before = seen.get(file.id);
    if (before === undefined) arrivals.push({ kind: "created", file });
    else if (file.version > before) arrivals.push({ kind: "updated", file });
  }
  return arrivals;
}

/** "Alex via Claude created proposal.md", "Alex via Claude saved brief.md v3". */
export function arrivalMessage({ kind, file }: Arrival): string {
  const who = actorLabel(file.updatedBy);
  return kind === "created" ? `${who} created ${file.name}` : `${who} saved ${file.name} v${file.version}`;
}
