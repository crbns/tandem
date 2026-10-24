import { invalidCursor } from "../errors.js";

/** Opaque to clients: base64url JSON of the workspace id and the last seen event seq. */
export function encodeCursor(workspaceId: string, seq: number): string {
  return Buffer.from(JSON.stringify({ w: workspaceId, s: seq })).toString(
    "base64url",
  );
}

/** Returns the cursor's seq, or throws invalidCursor() unless it is for `workspaceId` and not past `headSeq`. */
export function decodeCursor(
  cursor: string,
  workspaceId: string,
  headSeq: number,
): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  const { w, s } = (parsed ?? {}) as { w?: unknown; s?: unknown };
  if (
    w !== workspaceId ||
    typeof s !== "number" ||
    !Number.isInteger(s) ||
    s < 0 ||
    s > headSeq
  ) {
    throw invalidCursor();
  }
  return s;
}
