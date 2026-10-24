import type { ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { normalizeError } from "./errors";
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

async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw normalizeError(err);
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
