import type { ConvexReactClient } from "convex/react";
// Through the workspace package, not a relative path, so `turbo prune web`
// keeps packages/backend in the Docker build context.
import { api } from "@repo/backend/convex/_generated/api.js";
import type { Doc, Id } from "@repo/backend/convex/_generated/dataModel.js";
import { normalizeError, TandemApiError } from "./errors";
import type { TandemApi } from "./tandemApi";
import type {
  Actor,
  FileDetail,
  FileSummary,
  ProjectContext,
  Revision,
} from "./types";

type BackendActor = Doc<"files">["updatedBy"];
type BackendFileMetadata = {
  id: Id<"files">;
  workspaceId: Id<"workspaces">;
  parentId: Id<"folders"> | null;
  name: string;
  mimeType: string;
  version: number;
  updatedAt: number;
  updatedBy: BackendActor;
};

function toActor(actor: BackendActor): Actor {
  return {
    actorType: actor.type === "agent" ? "agent" : "human",
    userId: actor.userId ?? "",
    userName:
      actor.userName ?? (actor.type === "agent" ? undefined : actor.label),
    ...(actor.type === "agent" ? { agentName: actor.label } : {}),
    ...(actor.client ? { agentClient: actor.client } : {}),
  };
}

function toFileSummary(file: BackendFileMetadata): FileSummary {
  return {
    id: file.id,
    workspaceId: file.workspaceId,
    parentId: file.parentId ?? null,
    name: file.name,
    mimeType: file.mimeType,
    version: file.version,
    updatedAt: file.updatedAt,
    updatedBy: toActor(file.updatedBy),
  };
}

// The Convex client never rejects while disconnected: queries wait for the
// socket and mutations queue until it's back. Without a deadline, "Saving…" and
// page loads would hang on flaky Wi-Fi. A timed-out mutation may still land
// later; the next save then conflicts instead of overwriting (see errorCopy).
export const CALL_TIMEOUT_MS = 15_000;

export async function call<T>(
  run: () => Promise<T>,
  timeoutMs = CALL_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TandemApiError("NETWORK", { cause: "timed out" })),
      timeoutMs,
    );
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
      call(async () => {
        const workspaces = await convex.query(
          api.workspaces.listWorkspaces,
          {},
        );
        return workspaces.map(({ id, name, role }) => ({ id, name, role }));
      }),
    createWorkspace: (name) =>
      call(() => convex.mutation(api.workspaces.createWorkspace, { name })),
    createInvite: (workspaceId, role) => call(() => convex.mutation(api.workspaces.createWorkspaceInvite, {
      workspaceId: workspaceId as Id<"workspaces">, role,
    })),
    acceptInvite: (token) => call(() => convex.mutation(api.workspaces.acceptWorkspaceInvite, { token })),
    listInvites: (workspaceId) => call(() => convex.query(api.workspaces.listWorkspaceInvites, {
      workspaceId: workspaceId as Id<"workspaces">,
    })),
    revokeInvite: (inviteId) => call(async () => {
      await convex.mutation(api.workspaces.revokeWorkspaceInvite, { inviteId: inviteId as Id<"workspace_invites"> });
    }),
    listFiles: (workspaceId) =>
      call(async () => {
        const files = await convex.query(api.files.listFiles, {
          workspaceId: workspaceId as Id<"workspaces">,
        });
        return files.map(toFileSummary);
      }),
    createFile: async (workspaceId, input) => {
      const file = await call(() =>
        convex.mutation(api.files.createDocument, {
          workspaceId: workspaceId as Id<"workspaces">,
          ...input,
        }),
      );
      return { id: file.id, version: file.version };
    },
    readFile: (fileId) =>
      call(async () => {
        const result = await convex.query(api.files.readFile, {
          fileId: fileId as Id<"files">,
        });
        return {
          ...toFileSummary(result.file),
          content: result.content,
          permissions: { canEdit: true },
        } satisfies FileDetail;
      }),
    updateFileContent: async (fileId, update) => {
      const file = await call(() =>
        convex.mutation(api.files.updateDocument, {
          fileId: fileId as Id<"files">,
          ...update,
        }),
      );
      return { version: file.version };
    },
    listRevisions: (fileId) =>
      call(async () => {
        const revisions = await convex.query(api.files.getFileVersions, {
          fileId: fileId as Id<"files">,
          limit: 100,
        });
        return revisions.map(
          ({ version, createdAt, actor }): Revision => ({
            ...toActor(actor),
            version,
            createdAt,
          }),
        );
      }),
    getRevision: (fileId, version) =>
      call(async () => {
        const revision = await convex.query(api.files.getFileRevision, {
          fileId: fileId as Id<"files">,
          version,
        });
        if (!revision) return null;
        return {
          ...toActor(revision.actor),
          version: revision.version,
          createdAt: revision.createdAt,
          content: revision.content,
        } satisfies Revision;
      }),
    getContext: (workspaceId) =>
      call(async () => {
        const context = await convex.query(api.workspaces.getWorkspaceContext, {
          workspaceId: workspaceId as Id<"workspaces">,
        });
        if (!context?.goal) return null;
        return {
          goal: context.goal.text,
          scope: context.scope?.text ?? "",
          constraints: context.constraints.map(({ text }) => text),
          decisions: context.decisions.map(({ text }) => text),
          version: context.revision,
          approvedBy: toActor(context.goal.updatedBy),
          approvedAt: context.goal.updatedAt,
        } satisfies ProjectContext;
      }),
  };
}
