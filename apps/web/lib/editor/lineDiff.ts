import { diffLines } from "diff";

export interface DiffLine {
  text: string;
  /** True when this line isn't in the other side. */
  changed: boolean;
}

function toLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Line-level highlight for the conflict view: "mine" (old) vs "theirs" (new). */
export function sideBySide(mine: string, theirs: string): { mine: DiffLine[]; theirs: DiffLine[] } {
  const left: DiffLine[] = [];
  const right: DiffLine[] = [];
  // Without ignoreNewlineAtEof, an unchanged last line that lacks a trailing
  // newline shows as removed and re-added when the other side appends a line.
  for (const part of diffLines(mine, theirs, { ignoreNewlineAtEof: true })) {
    const lines = toLines(part.value);
    if (!part.added) left.push(...lines.map((text) => ({ text, changed: part.removed })));
    if (!part.removed) right.push(...lines.map((text) => ({ text, changed: part.added })));
  }
  return { mine: left, theirs: right };
}
