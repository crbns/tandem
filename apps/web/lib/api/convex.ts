import type { ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { normalizeError, TandemApiError } from "./errors";
import type { TandemApi } from "./tandemApi";
import type { FileDetail, FileSummary, Revision, Workspace } from "./types";

// `convex/_generated/api` doesn't exist yet (backend has only an empty schema),
// so we reference functions by their agreed "module:export" names. When Person 2
// lands them, swap these for `api.files.list` etc.; the call sites don't change.
// Names and any mismatches are tracked in CONTRACT_NOTES.md.
const fns = {
  listWorkspaces: makeFunctionReference<"query", Record<string, never>, Workspace[]>(
    "workspaces:mine",
  ),
  listFiles: makeFunctionReference<"query", { workspaceId: string }, FileSummary[]>("files:list"),
  createFile: makeFunctionReference<
    "mutation",
    // Spelled out: Convex arg types need an index signature, which interfaces lack.
    { workspaceId: string; name: string; mimeType: string; content?: string },
    { id: string; version: number }
  >("files:create"),
  readFile: makeFunctionReference<"query", { fileId: string }, FileDetail>("files:get"),
  updateFileContent: makeFunctionReference<
    "mutation",
    { fileId: string; expectedVersion: number; content: string },
    { version: number }
  >("files:updateContent"),
  listRevisions: makeFunctionReference<"query", { fileId: string }, Revision[]>("revisions:list"),
};

// The Convex client never rejects while disconnected: queries wait for the
// socket and mutations queue until it's back. Without a deadline, "Saving…" and
// page loads would hang on flaky Wi-Fi. A timed-out mutation may still land
// later; the next save then conflicts instead of overwriting (see errorCopy).
export const CALL_TIMEOUT_MS = 15_000;

export async function call<T>(run: () => Promise<T>, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TandemApiError("NETWORK", { cause: "timed out" })), timeoutMs);
  });
  try {
    return await Promise.race([run(), deadline]);
  } catch (err) {
    throw normalizeError(err);
  } finally {
    clearTimeout(timer);
  }
}

/** One-shot query/mutation calls only; no reactive subscriptions in P0. */
export function createConvexApi(convex: ConvexReactClient): TandemApi {
  return {
    listWorkspaces: () => call(() => convex.query(fns.listWorkspaces, {})),
    listFiles: (workspaceId) => call(() => convex.query(fns.listFiles, { workspaceId })),
    createFile: (workspaceId, input) =>
      call(() => convex.mutation(fns.createFile, { workspaceId, ...input })),
    readFile: (fileId) => call(() => convex.query(fns.readFile, { fileId })),
    updateFileContent: (fileId, update) =>
      call(() => convex.mutation(fns.updateFileContent, { fileId, ...update })),
    listRevisions: (fileId) => call(() => convex.query(fns.listRevisions, { fileId })),
  };
}
