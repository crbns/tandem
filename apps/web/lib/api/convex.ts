import type { ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import {
  type BackendFile,
  type BackendReadFile,
  type BackendRevision,
  type BackendWorkspace,
  type BackendWorkspaceContext,
  toFileDetail,
  toFileSummary,
  toProjectContext,
  toRevisions,
  toWorkspace,
} from "./convexMappers";
import { normalizeError, TandemApiError } from "./errors";
import type { TandemApi } from "./tandemApi";

// The backend's real "module:export" names (codex/backend-convex-vultr). The
// web app doesn't import its `_generated/api` yet, so they're referenced by
// name; swap for `api.files.listFiles` etc. once it does. Return shapes are the
// backend's and are mapped to the web types in `convexMappers.ts`, so
// components never see them. Gaps are tracked in CONTRACT_NOTES.md.
const fns = {
  listWorkspaces: makeFunctionReference<"query", Record<string, never>, BackendWorkspace[]>(
    "workspaces:listWorkspaces",
  ),
  listFiles: makeFunctionReference<"query", { workspaceId: string }, BackendFile[]>("files:listFiles"),
  createDocument: makeFunctionReference<
    "mutation",
    // Spelled out: Convex arg types need an index signature, which interfaces lack.
    { workspaceId: string; name: string; mimeType: string; content: string },
    BackendFile
  >("files:createDocument"),
  readFile: makeFunctionReference<"query", { fileId: string }, BackendReadFile>("files:readFile"),
  updateDocument: makeFunctionReference<
    "mutation",
    { fileId: string; expectedVersion: number; content: string },
    BackendFile
  >("files:updateDocument"),
  getFileVersions: makeFunctionReference<"query", { fileId: string }, BackendRevision[]>(
    "files:getFileVersions",
  ),
  getWorkspaceContext: makeFunctionReference<
    "query",
    { workspaceId: string },
    BackendWorkspaceContext | null
  >("workspaces:getWorkspaceContext"),
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
    listWorkspaces: () =>
      call(async () => (await convex.query(fns.listWorkspaces, {})).map(toWorkspace)),
    listFiles: (workspaceId) =>
      call(async () => (await convex.query(fns.listFiles, { workspaceId })).map(toFileSummary)),
    createFile: (workspaceId, input) =>
      call(async () => {
        const file = await convex.mutation(fns.createDocument, { workspaceId, ...input });
        return { id: file.id, version: file.version };
      }),
    readFile: (fileId) => call(async () => toFileDetail(await convex.query(fns.readFile, { fileId }))),
    updateFileContent: (fileId, update) =>
      call(async () => {
        const file = await convex.mutation(fns.updateDocument, { fileId, ...update });
        return { version: file.version };
      }),
    listRevisions: (fileId) =>
      call(async () => toRevisions(await convex.query(fns.getFileVersions, { fileId }))),
    getContext: (workspaceId) =>
      call(async () => toProjectContext(await convex.query(fns.getWorkspaceContext, { workspaceId }))),
  };
}
