// Change summaries for revision history: how much a version changed, not
// what. Assistants that need the actual difference read both versions.

/**
 * Lines added and removed between two texts, counted as multisets of lines:
 * a line that moved without changing counts as neither. Cheap and stable for
 * a summary; it is not a minimal edit script.
 */
export function lineChanges(
  before: string,
  after: string,
): { linesAdded: number; linesRemoved: number } {
  const counts = new Map<string, number>();
  for (const line of lines(before)) counts.set(line, (counts.get(line) ?? 0) + 1);
  let linesAdded = 0;
  for (const line of lines(after)) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else linesAdded++;
  }
  let linesRemoved = 0;
  for (const left of counts.values()) linesRemoved += left;
  return { linesAdded, linesRemoved };
}

function lines(text: string): string[] {
  if (text === "") return [];
  const split = text.replace(/\r\n/g, "\n").split("\n");
  // A trailing newline ends the last line; it doesn't start an empty one.
  if (split[split.length - 1] === "") split.pop();
  return split;
}
