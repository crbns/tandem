import type { Actor, FileDetail, FileSummary, ProjectContext, Revision, Workspace } from "./types";

// Wire shapes returned by the backend on `codex/backend-convex-vultr`
// (packages/backend/convex/{files,workspaces}.ts). Copied by hand because the
// web app doesn't import the backend's `_generated` types yet. Convex ids are
// plain strings on the wire. Mismatches with `types.ts` are in CONTRACT_NOTES.md.

export interface BackendActor {
  type: "human" | "agent" | "system";
  userId?: string;
  agentConnectionId?: string;
  label: string;
}

export interface BackendFile {
  id: string;
  workspaceId: string;
  parentId: string | null;
  name: string;
  mimeType: string;
  version: number;
  updatedAt: number;
  updatedBy: BackendActor;
}

export interface BackendReadFile {
  file: BackendFile;
  content: string | null;
}

export interface BackendRevision {
  id: string;
  version: number;
  content: string;
  actor: BackendActor;
  createdAt: number;
}

export interface BackendWorkspace {
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
  updatedAt: number;
}

interface BackendContextEntry {
  text: string;
  sourceFileIds: string[];
  updatedAt: number;
}

export interface BackendWorkspaceContext {
  goal: BackendContextEntry | null;
  scope: BackendContextEntry | null;
  constraints: BackendContextEntry[];
  decisions: BackendContextEntry[];
  ownership: BackendContextEntry[];
  openQuestions: BackendContextEntry[];
  revision: number;
  updatedAt: number;
}

/** userId for system actors; never collides with a Convex users id. */
export const SYSTEM_USER_ID = "system";

/**
 * The backend's `label` is the only display name it sends, so it becomes the
 * person's name for humans and the assistant's name for agents. The backend
 * doesn't yet say whose assistant an agent is (no person name on agent
 * actors), so agents render as "Claude (agent)" until it does.
 *
 * `system` actors (Tandem itself, e.g. a scheduled job) render as a named
 * human-type actor: the web Actor has no third type, and a system write is not
 * an assistant acting for someone, so labelling it "(agent)" would mislead.
 */
export function toActor(actor: BackendActor): Actor {
  switch (actor.type) {
    case "agent":
      return {
        actorType: "agent",
        userId: actor.userId ?? "",
        agentName: actor.label,
        ...(actor.agentConnectionId ? { agentClient: actor.agentConnectionId } : {}),
      };
    case "system":
      return { actorType: "human", userId: SYSTEM_USER_ID, userName: actor.label };
    case "human":
      return { actorType: "human", userId: actor.userId ?? "", userName: actor.label };
  }
}

export function toWorkspace(ws: BackendWorkspace): Workspace {
  return { id: ws.id, name: ws.name };
}

/** `custody` is omitted: the backend doesn't send it, and the register shows unknown marks rather than guessing. */
export function toFileSummary(file: BackendFile): FileSummary {
  return {
    id: file.id,
    workspaceId: file.workspaceId,
    parentId: file.parentId,
    name: file.name,
    mimeType: file.mimeType,
    version: file.version,
    updatedAt: file.updatedAt,
    updatedBy: toActor(file.updatedBy),
  };
}

/**
 * `readFile` only succeeds for workspace members, and every member may call
 * `updateDocument`, so a readable file is editable. Revisit once roles gate edits.
 */
export function toFileDetail({ file, content }: BackendReadFile): FileDetail {
  return { ...toFileSummary(file), content, permissions: { canEdit: true } };
}

/** Newest first. The backend already orders desc; sort anyway so the contract doesn't hinge on it. */
export function toRevisions(revisions: BackendRevision[]): Revision[] {
  return revisions
    .map((r) => ({ ...toActor(r.actor), version: r.version, createdAt: r.createdAt, content: r.content }))
    .sort((a, b) => b.version - a.version);
}

/**
 * Who approved isn't returned (the backend stores `updatedBy` on the context
 * but doesn't send it), so the badge shows an anonymous teammate rather than a
 * guessed name. Approval is human-only, so "human" is the honest type.
 */
const UNKNOWN_APPROVER: Actor = { actorType: "human", userId: "" };

/**
 * The dashboard's "approved goal" card needs a goal. The backend creates an
 * empty context row with every workspace, so "no goal yet" is the null case.
 */
export function toProjectContext(ctx: BackendWorkspaceContext | null): ProjectContext | null {
  if (!ctx?.goal) return null;
  return {
    goal: ctx.goal.text,
    scope: ctx.scope?.text ?? "",
    constraints: ctx.constraints.map((c) => c.text),
    decisions: ctx.decisions.map((d) => d.text),
    version: ctx.revision,
    approvedBy: UNKNOWN_APPROVER,
    approvedAt: ctx.goal.updatedAt,
  };
}
