import { CONVEX_SITE_URL } from "../config";
import type { ConvexReactClient } from "convex/react";
import type { FunctionReturnType } from "convex/server";
// Through the workspace package, not a relative path, so `turbo prune web`
// keeps packages/backend in the Docker build context.
import { api } from "@repo/backend/convex/_generated/api.js";
import type { Doc, Id } from "@repo/backend/convex/_generated/dataModel.js";
import { normalizeError, TandemApiError } from "./errors";
import type { TandemApi } from "./tandemApi";
import type {
  ContextDetails,
  ContextEntry,
  Actor,
  AgentConnection,
  ContextProposal,
  FileDetail,
  FileSummary,
  FolderSummary,
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

/**
 * The backend actor as the dashboard's Actor. An agent write names the person
 * (`userName`) and the assistant (`client`, display `label`); the connection id
 * is the backend's business and never shown.
 */
export function toActor(actor: BackendActor): Actor {
  const userId = actor.userId ?? "";
  if (actor.type === "agent") {
    return {
      actorType: "agent",
      userId,
      ...(actor.userName ? { userName: actor.userName } : {}),
      agentName: actor.label,
      ...(actor.client ? { agentClient: actor.client } : {}),
    };
  }
  // Humans and system writes: the label is the name ("Tandem" for system).
  return { actorType: "human", userId, userName: actor.userName ?? actor.label };
}

type BackendProposal = FunctionReturnType<typeof api.context.getApprovals>[number];

function toProposal(proposal: BackendProposal): ContextProposal {
  return {
    id: proposal.id,
    workspaceId: proposal.workspaceId,
    field: proposal.field,
    proposedValue: proposal.proposedValue,
    rationale: proposal.rationale,
    sourceFileIds: proposal.sourceFileIds,
    status: proposal.status,
    supersedes: proposal.supersedes,
    createdBy: toActor(proposal.createdBy),
    createdAt: proposal.createdAt,
    decidedBy: proposal.decidedBy ? toActor(proposal.decidedBy) : null,
    decidedAt: proposal.decidedAt,
  };
}

type BackendAgentConnection = FunctionReturnType<typeof api.agentConnections.listAgentConnections>[number];

export function toAgentConnection(connection: BackendAgentConnection): AgentConnection {
  const optional = <K extends string, V>(key: K, value: V | null | undefined) =>
    value === null || value === undefined ? {} : ({ [key]: value } as Record<K, V>);
  return {
    id: connection.connectionId,
    userId: connection.userId,
    client: connection.client,
    createdAt: connection.createdAt,
    ...optional("userName", connection.userName),
    ...optional("displayName", connection.displayName),
    ...optional("authKind", connection.authKind),
    ...optional("oauthClientName", connection.oauthClientName),
    ...optional("lastMcpActionAt", connection.lastMcpActionAt),
    ...optional("lastSyncAt", connection.lastSyncAt),
    ...optional("revokedAt", connection.revokedAt),
  };
}

type BackendListing = FunctionReturnType<typeof api.folders.listDirectory>;
type BackendFolder = BackendListing["folders"][number];

function toFolderSummary(folder: BackendFolder): FolderSummary {
  return {
    id: folder.id,
    workspaceId: folder.workspaceId,
    parentId: folder.parentId ?? null,
    name: folder.name,
    path: folder.path,
    revision: folder.revision,
    updatedAt: folder.updatedAt,
    updatedBy: toActor(folder.updatedBy),
  };
}

function toFileSummary(file: BackendFileMetadata & { path?: string }): FileSummary {
  return {
    ...(file.path !== undefined ? { path: file.path } : {}),
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

/** Keep this mapping separate from the compact approved-goal summary. */
export function toContextDetails(context: FunctionReturnType<typeof api.context.getDetails>): ContextDetails {
  const entry = (value: NonNullable<typeof context.goal>): ContextEntry => ({
    ...value, sourceFileIds: [...value.sourceFileIds], updatedBy: toActor(value.updatedBy),
    resolvedBy: value.resolvedBy ? toActor(value.resolvedBy) : null,
  });
  return {
    goal: context.goal ? entry(context.goal) : null,
    scope: context.scope ? entry(context.scope) : null,
    constraints: context.constraints.map(entry), decisions: context.decisions.map(entry),
    ownership: context.ownership.map(entry), openQuestions: context.openQuestions.map(entry),
    version: context.revision,
  };
}

// The Convex client never rejects while disconnected: queries wait for the
// socket and mutations queue until it's back. Without a deadline, "Saving…" and
// page loads would hang on flaky Wi-Fi. A timed-out mutation may still land
// later; the next save then conflicts instead of overwriting (see errorCopy).
export const CALL_TIMEOUT_MS = 15_000;
const UPLOAD_MUTATION_TIMEOUT_MS = 30_000;
export const MAX_LIST_FILES = 10_000;
const FILES_PAGE_SIZE = 100;

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

/**
 * One-shot query/mutation calls, plus one reactive subscription
 * (`watchWorkspace`) that only signals "something changed, refetch".
 */
export function createConvexApi(convex: ConvexReactClient, getToken: () => string | null | undefined = () => null): TandemApi {
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
        const files: FileSummary[] = [];
        let cursor: string | null = null;
        const seenCursors = new Set<string>();
        for (let page = 0; page < MAX_LIST_FILES / FILES_PAGE_SIZE; page++) {
          const result: { page: BackendFileMetadata[]; isDone: boolean; continueCursor: string } = await convex.query(api.files.listFiles, {
            workspaceId: workspaceId as Id<"workspaces">,
            paginationOpts: { numItems: FILES_PAGE_SIZE, cursor },
          });
          files.push(...result.page.map(toFileSummary));
          if (files.length > MAX_LIST_FILES) throw new TandemApiError("LIST_LIMIT_EXCEEDED");
          if (result.isDone) return files;
          if (!result.continueCursor || seenCursors.has(result.continueCursor))
            throw new TandemApiError("LIST_LIMIT_EXCEEDED");
          seenCursors.add(result.continueCursor);
          cursor = result.continueCursor;
        }
        throw new TandemApiError("LIST_LIMIT_EXCEEDED");
      }),
    createFile: async (workspaceId, { parentId, ...input }) => {
      const file = await call(() =>
        convex.mutation(api.files.createDocument, {
          workspaceId: workspaceId as Id<"workspaces">,
          ...input,
          ...(parentId ? { parentId: parentId as Id<"folders"> } : {}),
        }),
      );
      return { id: file.id, version: file.version };
    },
    moveFile: (fileId, parentId, expectedVersion) => call(async () => {
      const { version } = await convex.mutation(api.files.moveFile, {
        fileId: fileId as Id<"files">, parentId: parentId as Id<"folders"> | null, expectedVersion,
      });
      return { version };
    }),
    listDirectory: (workspaceId, folderId) => call(async () => {
      const listing = await convex.query(api.folders.listDirectory, {
        workspaceId: workspaceId as Id<"workspaces">,
        ...(folderId ? { folderId: folderId as Id<"folders"> } : {}),
      });
      return {
        folder: listing.folder ? toFolderSummary(listing.folder) : null,
        breadcrumbs: listing.breadcrumbs.map(({ id, name }) => ({ id, name })),
        folders: listing.folders.map(toFolderSummary),
        files: listing.files.map(toFileSummary),
      };
    }),
    listFolderTree: (workspaceId) => call(async () => {
      const folders = await convex.query(api.folders.listFolderTree, { workspaceId: workspaceId as Id<"workspaces"> });
      return folders.map(toFolderSummary);
    }),
    createFolder: (workspaceId, { name, parentId }) => call(async () => toFolderSummary(await convex.mutation(api.folders.createFolder, {
      workspaceId: workspaceId as Id<"workspaces">, name,
      ...(parentId ? { parentId: parentId as Id<"folders"> } : {}),
    }))),
    renameFolder: (folderId, name, expectedRevision) => call(async () => toFolderSummary(await convex.mutation(api.folders.renameFolder, {
      folderId: folderId as Id<"folders">, name, expectedRevision,
    }))),
    moveFolder: (folderId, parentId, expectedRevision) => call(async () => toFolderSummary(await convex.mutation(api.folders.moveFolder, {
      folderId: folderId as Id<"folders">, parentId: parentId as Id<"folders"> | null, expectedRevision,
    }))),
    deleteFolder: (folderId, expectedRevision) => call(async () => {
      const { deletedFiles, deletedFolders } = await convex.mutation(api.folders.deleteFolder, {
        folderId: folderId as Id<"folders">, expectedRevision,
      });
      return { deletedFiles, deletedFolders };
    }),
    renameFile: async (fileId, name, expectedVersion) => {
      const file = await call(() => convex.mutation(api.files.renameFile, { fileId: fileId as Id<"files">, name, expectedVersion }));
      return { version: file.version };
    },
    deleteFile: async (fileId, expectedVersion) => {
      await call(() => convex.mutation(api.files.deleteFile, { fileId: fileId as Id<"files">, expectedVersion }));
    },
    uploadFile: async (workspaceId, file, target) => {
      try {
        // A late URL creates no file and cannot continue this timed-out chain.
        const uploadUrl = await call(() => convex.mutation(api.files.generateUploadUrl, { workspaceId: workspaceId as Id<"workspaces"> }), UPLOAD_MUTATION_TIMEOUT_MS);
        const controller = new AbortController();
        // Allow two minutes plus transfer time at 32 KiB/s, rather than sharing
        // the short mutation deadline with potentially large blob transfers.
        const transferTimeoutMs = 120_000 + Math.ceil(file.size / (32 * 1024)) * 1_000;
        let storageId: Id<"_storage">;
        try {
          ({ storageId } = await call(async () => {
            const response = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file, signal: controller.signal });
            if (!response.ok) throw new TandemApiError("NETWORK");
            return await response.json() as { storageId: Id<"_storage"> };
          }, transferTimeoutMs));
        } finally {
          // Also abort the transport when the deadline wins. A failed transfer
          // never reaches finalize, even if its response arrives later.
          controller.abort();
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const pending = new Promise<{ pending: true }>((resolve) => {
          timer = setTimeout(() => resolve({ pending: true }), UPLOAD_MUTATION_TIMEOUT_MS);
        });
        // This mutation cannot be cancelled. Keep its rejection handled after
        // the UI stops waiting, and let reactive queries surface a late commit.
        try {
          return await Promise.race([convex.mutation(api.files.finalizeUpload, {
            workspaceId: workspaceId as Id<"workspaces">, storageId, name: file.name,
            ...(target && "fileId" in target ? { fileId: target.fileId as Id<"files">, expectedVersion: target.expectedVersion } : {}),
            ...(target && "parentId" in target && target.parentId ? { parentId: target.parentId as Id<"folders"> } : {}),
          }).then((uploaded) => ({ id: uploaded.id, version: uploaded.version })), pending]);
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        throw normalizeError(err);
      }
    },
    getFileBlob: (fileId, version) => call(async () => {
      const token = getToken();
      if (!token) throw new TandemApiError("UNAUTHENTICATED");
      const site = new URL(CONVEX_SITE_URL || convex.url);
      if (!CONVEX_SITE_URL) {
        if (site.hostname.endsWith(".convex.cloud")) site.hostname = site.hostname.replace(/\.convex\.cloud$/, ".convex.site");
        else if ((site.hostname === "127.0.0.1" || site.hostname === "localhost") && site.port) site.port = String(Number(site.port) + 1);
      }
      const url = new URL(`/files/${encodeURIComponent(fileId)}/content`, site);
      if (version !== undefined) url.searchParams.set("version", String(version));
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new TandemApiError(response.status === 401 ? "UNAUTHENTICATED" : response.status === 403 ? "FORBIDDEN" : response.status === 404 ? "FILE_NOT_FOUND" : "NETWORK");
      return response.blob();
    }),
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
    restoreRevision: async (fileId, version, expectedVersion) => {
      const file = await call(() =>
        convex.mutation(api.files.restoreRevision, {
          fileId: fileId as Id<"files">,
          version,
          expectedVersion,
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
          constraints: context.constraints.filter((entry) => entry.status === "active").map(({ text }) => text),
          decisions: context.decisions.filter((entry) => entry.status === "active").map(({ text }) => text),
          version: context.revision,
          approvedBy: toActor(context.goal.updatedBy),
          approvedAt: context.goal.updatedAt,
        } satisfies ProjectContext;
      }),
    getContextDetails: (workspaceId) => call(async () => toContextDetails(await convex.query(api.context.getDetails, {
      workspaceId: workspaceId as Id<"workspaces">,
    }))),
    listWorkspaceMembers: (workspaceId) => call(async () => {
      const info = await convex.query(api.workspaces.getWorkspaceInfo, { workspaceId: workspaceId as Id<"workspaces"> });
      return info.members.map((m) => ({ userId: m.userId, name: m.name ?? "Workspace member" }));
    }),
    updateContextField: (workspaceId, { ownerUserId, ...input }) => call(() => convex.mutation(api.context.updateContextField, {
      ...input, workspaceId: workspaceId as Id<"workspaces">,
      sourceFileIds: input.sourceFileIds as Id<"files">[],
      ...(ownerUserId !== undefined ? { ownerUserId: ownerUserId as Id<"users"> } : {}),
    })),
    proposeContextChange: (workspaceId, { ownerUserId, ...input }) => call(() => convex.mutation(api.context.proposeContextChange, {
      ...input, workspaceId: workspaceId as Id<"workspaces">,
      sourceFileIds: input.sourceFileIds as Id<"files">[],
      ...(ownerUserId !== undefined ? { ownerUserId: ownerUserId as Id<"users"> } : {}),
    })),
    listPublishedWork: (workspaceId, cursor = null, pageSize = 20) => call(async () => {
      const result = await convex.query(api.context.listPublishedWork, {
        workspaceId: workspaceId as Id<"workspaces">, paginationOpts: { cursor, numItems: pageSize },
      });
      return { ...result, page: result.page.map((work) => ({ ...work, createdBy: toActor(work.createdBy) })) };
    }),
    listProposals: (workspaceId, status) =>
      call(async () => {
        const proposals = await convex.query(api.context.getApprovals, {
          workspaceId: workspaceId as Id<"workspaces">,
          ...(status ? { status } : {}),
        });
        return proposals.map(toProposal);
      }),
    decideProposal: ({ id, workspaceId }, decision) =>
      call(async () => {
        const proposalId = id as Id<"context_proposals">;
        await convex.mutation(api.context.decideContextProposal, { proposalId, decision });
        if (decision !== "approved") return;
        // A stale approval doesn't throw: the backend marks the proposal stale
        // and returns null. Look where it landed so the UI can say so.
        const stale = await convex.query(api.context.getApprovals, {
          workspaceId: workspaceId as Id<"workspaces">,
          status: "stale",
        });
        if (stale.some((p) => p.id === proposalId)) throw new TandemApiError("VERSION_CONFLICT");
      }),
    getMcpServerUrl: () => call(() => convex.query(api.agentConnections.getMcpServerUrl, {})),
    createAgentConnection: (workspaceId, { client, displayName }) =>
      call(() =>
        convex.action(api.agentConnections.createAgentConnection, {
          workspaceId: workspaceId as Id<"workspaces">,
          client,
          ...(displayName?.trim() ? { displayName: displayName.trim() } : {}),
        }),
      ),
    listAgentConnections: (workspaceId) =>
      call(async () => {
        const connections = await convex.query(api.agentConnections.listAgentConnections, {
          workspaceId: workspaceId as Id<"workspaces">,
        });
        return connections.map(toAgentConnection);
      }),
    revokeAgentConnection: (connectionId) =>
      call(async () => {
        await convex.mutation(api.agentConnections.revokeAgentConnection, {
          connectionId: connectionId as Id<"agent_connections">,
        });
      }),
    getConsentRequest: (requestId) =>
      call(async () => {
        const request = await convex.query(api.oauth.getConsentRequest, { requestId });
        if (!request) return null;
        return {
          status: request.status,
          suggestedClient: request.suggestedClient,
          scopes: request.scopes,
          workspaces: request.workspaces,
          ...(request.clientName ? { clientName: request.clientName } : {}),
          ...(request.redirectHost ? { redirectHost: request.redirectHost } : {}),
        };
      }),
    decideConsent: (requestId, decision) =>
      call(() =>
        convex.action(api.oauth.decideConsent, {
          requestId,
          ...(decision.approve
            ? {
                approve: true,
                workspaceId: decision.workspaceId as Id<"workspaces">,
                client: decision.client,
              }
            : { approve: false }),
        }),
      ),
    watchWorkspace: (workspaceId, onChange) => {
      // getWorkspaceInfo carries the newest workspace events; every commit,
      // proposal and decision records one. A bounded (20-row) subscription
      // instead of watching every file page.
      const watch = convex.watchQuery(api.workspaces.getWorkspaceInfo, {
        workspaceId: workspaceId as Id<"workspaces">,
      });
      let newest: string | null | undefined; // undefined until the first result
      return watch.onUpdate(() => {
        let info: ReturnType<typeof watch.localQueryResult>;
        try {
          info = watch.localQueryResult();
        } catch {
          return; // the page's own one-shot loads report errors
        }
        if (!info) return;
        const head = info.recentEvents[0]?.id ?? null;
        if (newest !== undefined && head !== newest) onChange();
        newest = head;
      });
    },
  };
}
