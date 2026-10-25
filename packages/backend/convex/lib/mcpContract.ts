// The MCP tool contract (snake_case fields, ISO times, coded errors), mapped
// from the internal camelCase shapes of convex/mcpTools.ts. Ported from the
// Node server's ConvexBackend (apps/mcp) so assistants see the same results
// and error codes as before. Pure functions: no ctx, no database.
import { ConvexError, type Value } from "convex/values";
import type { Doc } from "../_generated/dataModel";

type Actor = Doc<"workspace_events">["actor"];

interface FileRow {
  id: string;
  workspaceId: string;
  parentId: string | null;
  name: string;
  path: string;
  mimeType: string;
  version: number;
  updatedAt: number;
  updatedBy: Actor;
}

interface FolderRow {
  id: string;
  parentId: string | null;
  name: string;
  path: string;
  revision: number;
  updatedAt: number;
}

type Field = Doc<"context_proposals">["field"];

interface ProposalRow {
  id: string;
  workspaceId: string;
  field: Field;
  operation?: "add" | "resolve" | "remove";
  proposedValue: string;
  rationale: string;
  sourceFileIds: string[];
  status: "pending" | "applied" | "approved" | "rejected" | "stale";
  supersedes: string | null;
  createdBy: Actor;
  createdAt: number;
  decidedBy: Actor | null;
  decidedAt: number | null;
  ownerUserId: string | null;
  ownerArea: string | null;
}

interface ContextEntry {
  id: string;
  status: "active" | "resolved" | "superseded";
  resolvedBy: Actor | null;
  resolvedAt: number | null;
  supersededBy: string | null;
  text: string;
  sourceFileIds: string[];
  updatedAt: number;
  updatedBy: Actor;
}

interface ContextRow {
  goal: ContextEntry | null;
  scope: ContextEntry | null;
  constraints: ContextEntry[];
  decisions: ContextEntry[];
  ownership: (ContextEntry & { ownerUserId: string | null; ownerArea: string | null })[];
  openQuestions: ContextEntry[];
  revision: number;
  updatedAt: number;
  updatedBy: Actor;
}

interface TaskRow {
  id: string;
  title: string;
  description: string;
  status: "open" | "in_progress" | "done";
  ownerId: string | null;
  ownerName: string | null;
  version: number;
  createdBy: Actor;
  updatedBy: Actor;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

interface EventRow {
  seq: number;
  kind: string;
  entityId: string;
  summary: string;
  actor: Actor;
  createdAt: number;
}

// ---- Errors ---------------------------------------------------------------

export type ToolErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "FILE_NOT_FOUND"
  | "VERSION_CONFLICT"
  | "NAME_EXISTS"
  | "APPROVAL_REQUIRED"
  | "INVALID_INPUT"
  | "INVALID_PATH"
  | "PATH_NOT_FOUND"
  | "FOLDER_NOT_FOUND"
  | "INVALID_MOVE"
  | "FOLDER_TOO_DEEP"
  | "FOLDER_TOO_LARGE"
  | "TASK_NOT_FOUND"
  | "TASK_ALREADY_CLAIMED"
  | "TASK_NOT_OWNER"
  | "TASK_DONE";

/** A domain error that tool handlers turn into an `isError` tool result. */
export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export function invalidInput(message: string, details: Record<string, unknown> = {}) {
  return new ToolError("INVALID_INPUT", message, details);
}

function forbidden(workspaceId: string) {
  return new ToolError("FORBIDDEN", `You don't have access to workspace ${workspaceId}.`, {
    workspace_id: workspaceId,
  });
}

function fileNotFound(fileId: string) {
  return new ToolError(
    "FILE_NOT_FOUND",
    `No file with id ${fileId}. Call list_files to find the correct file_id.`,
    { file_id: fileId },
  );
}

function folderNotFound(folderId: string) {
  return new ToolError(
    "FOLDER_NOT_FOUND",
    `No folder with id ${folderId}. Call list_files to find the correct folder id.`,
    { folder_id: folderId },
  );
}

function invalidCursor() {
  return invalidInput("cursor is invalid or for another workspace; call sync_workspace without since");
}

export function approvalRequired(field: string) {
  return new ToolError(
    "APPROVAL_REQUIRED",
    "Changes to goal, scope, decisions or ownership need human approval. Use propose_context_change.",
    { field },
  );
}

export interface ErrorHint {
  fileId?: string;
  folderId?: string;
  taskId?: string;
  expectedVersion?: number;
  workspaceId?: string;
  /**
   * The tool that failed, so recovery hints name a next step it fits
   * (VERSION_CONFLICT retries default to update_document).
   */
  tool?: "update_document" | "create_document" | "create_folder" | "move_file" | "move_folder";
}

export function codeOf(err: ConvexError<Value>): string | undefined {
  const data = err.data as { code?: unknown } | string;
  if (typeof data === "string") return data;
  return typeof data?.code === "string" ? data.code : undefined;
}

/** True when Convex rejected the credential itself (no presence to record). */
export function isUnauthenticated(err: unknown): boolean {
  return err instanceof ConvexError && codeOf(err) === "UNAUTHENTICATED";
}

/** Maps backend error codes to the tool contract (see docs/mvp-integration.md). */
export function toToolError(err: unknown, hint: ErrorHint = {}): unknown {
  if (err instanceof ToolError || !(err instanceof ConvexError)) return err;
  const code = codeOf(err);
  const data = (typeof err.data === "object" && err.data ? err.data : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof data[k] === "string" ? (data[k] as string) : undefined);
  const num = (k: string) => (typeof data[k] === "number" ? (data[k] as number) : undefined);
  switch (code) {
    case "UNAUTHENTICATED":
      return new ToolError(
        "UNAUTHENTICATED",
        "This agent connection is invalid or was revoked. Ask the user to reconnect Tandem.",
      );
    case "FORBIDDEN":
    case "WORKSPACE_NOT_FOUND":
      if (str("scope"))
        return new ToolError(
          "FORBIDDEN",
          "This connection is read-only. Ask the user to reconnect Tandem with write access.",
          { scope: str("scope") },
        );
      return forbidden(str("workspaceId") ?? hint.workspaceId ?? "(this workspace)");
    case "FILE_NOT_FOUND":
    case "INVALID_SOURCE_FILE":
      return fileNotFound(str("fileId") ?? hint.fileId ?? "(unknown)");
    case "VERSION_CONFLICT": {
      if (num("currentRevision") !== undefined) {
        // A folder: its optimistic-lock counter is `revision`.
        const folderId = str("folderId") ?? hint.folderId ?? "(unknown)";
        const current = num("currentRevision")!;
        const expected = num("expectedRevision") ?? 0;
        return new ToolError(
          "VERSION_CONFLICT",
          `Folder ${folderId} is at revision ${current}, not ${expected}; someone else changed it. ` +
            `Call list_files to see where it is now, then retry move_folder with expected_revision=${current}.`,
          { folder_id: folderId, current_revision: current, expected_revision: expected },
        );
      }
      const taskId = str("taskId");
      if (taskId) {
        const current = num("currentVersion") ?? 0;
        const expected = num("expectedVersion") ?? hint.expectedVersion ?? 0;
        return new ToolError(
          "VERSION_CONFLICT",
          `Task ${taskId} is at version ${current}, not ${expected}; someone else changed it. ` +
            `Call manage_task with operation "list" to re-read it; if it is still open, retry with ` +
            `expected_version=${current}, otherwise pick another task.`,
          { task_id: taskId, current_version: current, expected_version: expected },
        );
      }
      const fileId = str("fileId") ?? hint.fileId ?? "(unknown)";
      const current = num("currentVersion") ?? 0;
      const expected = num("expectedVersion") ?? hint.expectedVersion ?? 0;
      return new ToolError(
        "VERSION_CONFLICT",
        `File ${fileId} is at version ${current}, not ${expected}; someone else changed it. ` +
          (hint.tool === "move_file"
            ? `Re-read the file with read_file and check the move still makes sense, `
            : `Re-read the file with read_file, merge your changes into the latest content, `) +
          `then retry ${hint.tool === "move_file" ? "move_file" : "update_document"} with expected_version=${current}.`,
        { file_id: fileId, current_version: current, expected_version: expected },
      );
    }
    case "NAME_EXISTS": {
      const moving = hint.tool === "move_file" || hint.tool === "move_folder";
      if (str("kind") === "folder") {
        const folderId = str("folderId") ?? "";
        const name = str("name") ?? "";
        return new ToolError(
          "NAME_EXISTS",
          `A folder named ${JSON.stringify(name)} already exists there (folder_id ${folderId}). ` +
            (moving
              ? `Pass a different new_name or destination, or ask the user.`
              : `Choose a different name, or use that folder.`),
          { kind: "folder", folder_id: folderId, name },
        );
      }
      const fileId = str("fileId") ?? "";
      const name = str("name") ?? "";
      const current = num("currentVersion") ?? 1;
      // The name is untrusted workspace data, so quote it rather than splicing it into the sentence.
      return new ToolError(
        "NAME_EXISTS",
        `A file named ${JSON.stringify(name)} already exists (file_id ${fileId}, version ${current}). ` +
          (hint.tool === "create_folder"
            ? `A folder can't share a name with a file in the same folder: choose a different folder path, or ask the user.`
            : moving
              ? `Pass a different new_name or destination, or ask the user.`
              : `Read it with read_file. If it is the same document, merge your changes into it with update_document; ` +
                `otherwise choose a different name or ask the user.`),
        { kind: "file", file_id: fileId, name, current_version: current },
      );
    }
    case "TASK_NOT_FOUND": {
      const taskId = str("taskId") ?? hint.taskId ?? "(unknown)";
      return new ToolError(
        "TASK_NOT_FOUND",
        `No task with id ${taskId} in this workspace. Call manage_task with operation "list" to find the correct task_id.`,
        { task_id: taskId },
      );
    }
    case "TASK_ALREADY_CLAIMED":
    case "TASK_NOT_OWNER": {
      const taskId = str("taskId") ?? hint.taskId ?? "(unknown)";
      const ownerId = str("ownerUserId");
      const owner = ownerId ? { user_id: ownerId, name: str("ownerName") ?? "Workspace member" } : null;
      const current = num("currentVersion") ?? 0;
      // The owner's name is workspace data, so quote it rather than splicing it into the sentence.
      const by = owner ? ` by ${JSON.stringify(owner.name)} (user_id ${owner.user_id})` : "";
      return code === "TASK_ALREADY_CLAIMED"
        ? new ToolError(
            "TASK_ALREADY_CLAIMED",
            `Task ${taskId} is already claimed${by} (status ${str("status") ?? "unknown"}, version ${current}). ` +
              `Don't work on it: call manage_task with operation "list" and status "open", then claim another task.`,
            { task_id: taskId, owner, status: str("status") ?? null, current_version: current },
          )
        : new ToolError(
            "TASK_NOT_OWNER",
            `Task ${taskId} is claimed${by}, not by your user. Only its owner can update or complete it; ` +
              `pick another open task, or ask the user to coordinate with the owner.`,
            { task_id: taskId, owner, current_version: current },
          );
    }
    case "TASK_DONE": {
      const taskId = str("taskId") ?? hint.taskId ?? "(unknown)";
      return new ToolError(
        "TASK_DONE",
        `Task ${taskId} is already done and can't be changed. Create a new task if more work is needed.`,
        { task_id: taskId, current_version: num("currentVersion") ?? 0 },
      );
    }
    case "APPROVAL_REQUIRED":
      return approvalRequired(str("field") ?? "context");
    case "INVALID_CURSOR":
      return invalidCursor();
    case "INVALID_NAME": {
      // MCP reports invalid names as INVALID_INPUT (docs/filesystem.md), saying why.
      const moving = hint.tool === "move_file" || hint.tool === "move_folder";
      const why =
        str("reason") === "slash"
          ? moving
            ? 'it contains "/". new_name is only the name: pass the destination folder as to_folder_path (create it first with create_folder)'
            : 'it contains "/". To put a file in a folder, pass folder_path (create the folder first with create_folder)'
          : str("reason") === "dot"
            ? 'it is "." or ".."'
            : str("reason") === "length"
              ? hint.tool === "create_folder"
                ? "a folder name in the path is longer than 255 characters"
                : "it is empty or longer than 255 characters"
              : undefined;
      return invalidInput(
        `Invalid name${why ? `: ${why}.` : "."} A name is 1–255 visible characters, without "/", and not "." or "..".`,
        { field: "name" },
      );
    }
    case "FOLDER_NOT_FOUND":
    case "INVALID_PARENT_FOLDER":
      return folderNotFound(str("folderId") ?? hint.folderId ?? "(unknown)");
    case "INVALID_PATH": {
      const path = str("path") ?? "";
      // Paths may contain untrusted names, so quote them.
      return new ToolError(
        "INVALID_PATH",
        `Invalid path ${JSON.stringify(path)}. Write paths like "/specs/api/endpoints.md": ` +
          `names separated by "/", without empty, "." or ".." segments.`,
        { path },
      );
    }
    case "PATH_NOT_FOUND": {
      const path = str("path") ?? "";
      const recovery =
        str("found") === "folder"
          ? "That path is a folder; call list_files with it to see its contents."
          : str("found") === "file"
            ? "That path is a file, not a folder."
            : str("expected") === "file"
              ? "Call list_files to browse folders, or search_files to find the file."
              : "Call list_files on the parent folder, or create the folder with create_folder.";
      return new ToolError("PATH_NOT_FOUND", `Nothing at path ${JSON.stringify(path)}. ${recovery}`, { path });
    }
    case "INVALID_MOVE":
      return new ToolError(
        "INVALID_MOVE",
        "A folder can't be moved into itself or one of its own subfolders. Choose a destination outside it.",
        { folder_id: str("folderId") ?? hint.folderId ?? "(unknown)" },
      );
    case "FOLDER_TOO_DEEP":
      return new ToolError(
        "FOLDER_TOO_DEEP",
        `Folders can nest at most ${num("maxDepth") ?? 32} levels deep, and this would go deeper. Use a shallower folder.`,
        { max_depth: num("maxDepth") ?? 32 },
      );
    case "FOLDER_TOO_LARGE":
      // MCP can only hit the move limit (folders in the moved subtree); the
      // delete limit (folders and files) is dashboard-only.
      if (hint.tool === "move_folder")
        return new ToolError(
          "FOLDER_TOO_LARGE",
          `That folder has more than ${num("limit") ?? 2000} folders inside it, too many to move at once. ` +
            `Move its subfolders one at a time, or ask the user.`,
          { limit: num("limit") ?? 2000 },
        );
      return new ToolError(
        "FOLDER_TOO_LARGE",
        `That folder holds more than ${num("limit") ?? 500} items, too many for one operation. Ask the user.`,
        { limit: num("limit") ?? 500 },
      );
    case "INVALID_INPUT":
    case "PROPOSAL_NOT_FOUND":
    case "PROPOSAL_ALREADY_DECIDED":
    case "CONTEXT_NOT_INITIALIZED":
      return invalidInput(str("message") ?? `Invalid request (${code}).`, data);
    default:
      return err;
  }
}

// ---- Cursor ---------------------------------------------------------------

function base64UrlEncode(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

/** Opaque to clients: base64url JSON of the workspace id and the last seen event seq. */
export function encodeCursor(workspaceId: string, seq: number): string {
  // Workspace ids and integers are ASCII, so btoa is safe here.
  return base64UrlEncode(JSON.stringify({ w: workspaceId, s: seq }));
}

/** The cursor's workspace and seq; Convex checks the seq against its head. */
export function parseCursor(cursor: string): { workspaceId: string; seq: number } {
  try {
    const { w, s } = JSON.parse(base64UrlDecode(cursor)) as { w?: unknown; s?: unknown };
    if (typeof w === "string" && typeof s === "number" && Number.isSafeInteger(s) && s >= 0)
      return { workspaceId: w, seq: s };
  } catch {
    // Fall through.
  }
  throw invalidCursor();
}

// ---- Results --------------------------------------------------------------

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : iso(ms);
}

export function toAttribution(a: Actor) {
  const agent = a.type === "agent";
  return {
    actor_type: agent ? ("agent" as const) : ("human" as const),
    user_id: a.userId ?? "",
    client: a.client ?? (a.type === "system" ? "system" : agent ? "agent" : "dashboard"),
    ...(a.agentConnectionId ? { agent_connection_id: a.agentConnectionId } : {}),
    label: a.label,
  };
}

export function toFile(f: FileRow) {
  return {
    id: f.id,
    workspace_id: f.workspaceId,
    parent_id: f.parentId,
    name: f.name,
    path: f.path,
    mime_type: f.mimeType,
    version: f.version,
    updated_at: iso(f.updatedAt),
    updated_by: toAttribution(f.updatedBy),
  };
}

export function toFolder(f: FolderRow) {
  return {
    id: f.id,
    parent_id: f.parentId,
    name: f.name,
    path: f.path,
    revision: f.revision,
    updated_at: iso(f.updatedAt),
  };
}

type ProposalField = "goal" | "scope" | "constraints" | "decisions" | "ownership" | "open_questions";

function toProposalField(field: Field): ProposalField {
  switch (field) {
    case "constraint":
      return "constraints";
    case "decision":
      return "decisions";
    case "open_question":
      return "open_questions";
    default:
      return field;
  }
}

export function toProposal(p: ProposalRow, contextRevision: number) {
  return {
    base_context_version: contextRevision,
    id: p.id,
    workspace_id: p.workspaceId,
    field: toProposalField(p.field),
    operation: p.operation ?? "add",
    proposed_value:
      p.field === "ownership" && p.ownerUserId !== null && p.ownerArea !== null
        ? { area: p.ownerArea, owner_user_id: p.ownerUserId }
        : p.proposedValue,
    rationale: p.rationale,
    source_ids: p.sourceFileIds,
    status: p.status,
    supersedes: p.supersedes,
    proposed_by: toAttribution(p.createdBy),
    created_at: iso(p.createdAt),
    ...(p.decidedBy && p.decidedAt !== null
      ? {
          decided_by: { user_id: p.decidedBy.userId ?? "", actor_type: "human" as const },
          decided_at: iso(p.decidedAt),
        }
      : {}),
  };
}

function toContextEntry(e: ContextEntry) {
  return {
    source_ids: e.sourceFileIds,
    updated_at: iso(e.updatedAt),
    updated_by: toAttribution(e.updatedBy),
    id: e.id,
    text: e.text,
    status: e.status,
    resolved_by: e.resolvedBy ? toAttribution(e.resolvedBy) : null,
    resolved_at: e.resolvedAt,
    superseded_by: e.supersededBy,
  };
}

function toContext(c: ContextRow) {
  return {
    goal: c.goal?.text ?? "",
    scope: c.scope?.text ?? "",
    constraints: c.constraints.map(toContextEntry),
    decisions: c.decisions.map((e) => ({
      ...toContextEntry(e),
      decided_at: iso(e.updatedAt),
      source_ids: e.sourceFileIds,
    })),
    ownership: c.ownership.map((e) => {
      if (e.ownerUserId !== null && e.ownerArea !== null)
        return {
          ...toContextEntry(e),
          area: e.ownerArea,
          owner_user_id: e.ownerUserId,
        };
      // Legacy free-text entry ("area: owner").
      const sep = e.text.lastIndexOf(": ");
      return sep > 0
        ? {
            ...toContextEntry(e),
            area: e.text.slice(0, sep),
            owner_user_id: e.text.slice(sep + 2),
          }
        : { ...toContextEntry(e), area: e.text, owner_user_id: "" };
    }),
    open_questions: c.openQuestions.map((e) => ({
      ...toContextEntry(e),
      created_at: iso(e.updatedAt),
      created_by: toAttribution(e.updatedBy),
    })),
    updated_at: iso(c.updatedAt),
    updated_by: toAttribution(c.updatedBy),
  };
}

type SyncRow = {
  workspace: { id: string; name: string };
  context: ContextRow;
  pendingProposals: Pick<ProposalRow, "id" | "field" | "operation" | "proposedValue" | "supersedes" | "rationale" | "createdBy" | "createdAt">[];
  changedFiles: FileRow[];
  filesTruncated: boolean;
  folders: FolderRow[];
  foldersTruncated: boolean;
  recentWork: Parameters<typeof toPublished>[0][];
  workTruncated: boolean;
  tasks: TaskRow[];
  tasksTruncated: boolean;
  events: EventRow[];
  eventsTruncated: boolean;
  cursorSeq: number;
};

/** Cap on each list in the sync brief. */
export const BRIEF_LIMIT = 10;

/**
 * What an assistant should read first: the goal, what's decided, what's
 * blocking, and what just changed. Built only from the sync result; `truncated`
 * says a list was capped at BRIEF_LIMIT (the full lists are in context,
 * pending_proposals and events).
 */
function toSyncBrief(r: SyncRow) {
  const active = (entries: ContextEntry[]) => entries.filter((e) => e.status === "active");
  const decisions = active(r.context.decisions);
  const questions = active(r.context.openQuestions);
  return {
    goal: r.context.goal?.text ?? "",
    scope: r.context.scope?.text ?? "",
    // Newest last in context, so keep the tail.
    active_decisions: decisions.slice(-BRIEF_LIMIT).map((e) => ({ id: e.id, text: e.text })),
    blockers: {
      open_questions: questions.slice(-BRIEF_LIMIT).map((e) => ({ id: e.id, text: e.text })),
      pending_approvals: r.pendingProposals.slice(0, BRIEF_LIMIT).map((p) => ({
        id: p.id,
        field: toProposalField(p.field),
        proposed_value: p.proposedValue,
      })),
    },
    // Events arrive oldest first; the brief lists the newest first.
    recent_changes: r.events.slice(-BRIEF_LIMIT).reverse().map((e) => ({
      type: e.kind,
      subject_id: e.entityId,
      summary: e.summary,
      actor: e.actor.label,
      at: iso(e.createdAt),
    })),
    changed_file_count: r.changedFiles.length,
    truncated:
      decisions.length > BRIEF_LIMIT ||
      questions.length > BRIEF_LIMIT ||
      r.pendingProposals.length > BRIEF_LIMIT ||
      r.events.length > BRIEF_LIMIT,
  };
}

/**
 * `detail: "full"` keeps the whole contract with `brief` first; `"brief"`
 * drops context, proposals and events and trims files to id/name/version.
 */
export function toSyncResult(r: SyncRow, detail: "brief" | "full" = "full") {
  const brief = toSyncBrief(r);
  const cursor = encodeCursor(r.workspace.id, r.cursorSeq);
  if (detail === "brief")
    return {
      brief,
      workspace: r.workspace,
      context_version: r.context.revision,
      changed_files: r.changedFiles.map((f) => ({ id: f.id, name: f.name, path: f.path, version: f.version })),
      // The cursor acknowledges the whole event page, not just recent_changes.
      // Preserve every tombstone even when the brief's ten-event list is capped.
      deleted_file_ids: r.events.filter((e) => e.kind === "file.deleted").map((e) => e.entityId),
      files_truncated: r.filesTruncated,
      // Full publications: the cursor acknowledges them and no tool reads one by id.
      recent_work: r.recentWork.map(toPublished),
      work_truncated: r.workTruncated,
      // Full tasks too: they are small and the cursor acknowledges their changes.
      tasks: r.tasks.map(toTask),
      tasks_truncated: r.tasksTruncated,
      events_truncated: r.eventsTruncated,
      cursor,
    };
  return {
    brief,
    workspace: r.workspace,
    context: toContext(r.context),
    context_version: r.context.revision,
    pending_proposals: r.pendingProposals.map((p) => ({
      proposed_value: p.proposedValue,
      supersedes: p.supersedes,
      status: "pending" as const,
      id: p.id,
      field: toProposalField(p.field),
      operation: p.operation ?? "add",
      rationale: p.rationale,
      proposed_by: toAttribution(p.createdBy),
      created_at: iso(p.createdAt),
    })),
    changed_files: r.changedFiles.map(toFile),
    files_truncated: r.filesTruncated,
    folders: r.folders.map(toFolder),
    folders_truncated: r.foldersTruncated,
    recent_work: r.recentWork.map(toPublished),
    work_truncated: r.workTruncated,
    tasks: r.tasks.map(toTask),
    tasks_truncated: r.tasksTruncated,
    events: r.events.map((e) => ({
      seq: e.seq,
      workspace_id: r.workspace.id,
      type: e.kind,
      subject_id: e.entityId,
      actor: toAttribution(e.actor),
      at: iso(e.createdAt),
      summary: e.summary,
    })),
    events_truncated: r.eventsTruncated,
    cursor,
  };
}

export function toTask(t: TaskRow) {
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    status: t.status,
    owner: t.ownerId === null ? null : { user_id: t.ownerId, name: t.ownerName ?? "Workspace member" },
    version: t.version,
    created_by: toAttribution(t.createdBy),
    updated_by: toAttribution(t.updatedBy),
    created_at: iso(t.createdAt),
    updated_at: iso(t.updatedAt),
    completed_at: t.completedAt === null ? null : iso(t.completedAt),
  };
}

export function toPublished(w: {
  id: string;
  workspaceId: string;
  kind: "deliverable" | "finding";
  title: string;
  summary: string;
  fileIds: string[];
  createdBy: Actor;
  createdAt: number;
}) {
  return {
    id: w.id,
    workspace_id: w.workspaceId,
    kind: w.kind,
    title: w.title,
    summary: w.summary,
    file_ids: w.fileIds,
    published_by: toAttribution(w.createdBy),
    created_at: iso(w.createdAt),
  };
}

type ContextField = "goal" | "scope" | "constraints" | "decisions" | "ownership" | "open_questions";
type ProposedValue = string | { area: string; owner_user_id: string };

/** Convex's context model is canonical: one text value per proposal (plus the owner for ownership). */
export function toBackendProposal(
  field: ContextField,
  value: ProposedValue | undefined,
  operation: "add" | "resolve" | "remove" = "add",
): { field: Field; proposedValue?: string; ownerUserId?: string } {
  if (operation !== "add") {
    const fieldMap = { constraints: "constraint", decisions: "decision", open_questions: "open_question" } as const;
    return { field: field === "constraints" || field === "decisions" || field === "open_questions" ? fieldMap[field] : field };
  }
  const invalid = (expected: string) =>
    invalidInput(`proposed_value for ${field} must be ${expected}.`, { field });
  switch (field) {
    case "goal":
    case "scope":
      if (typeof value !== "string") throw invalid("the full new text, as a string");
      return { field, proposedValue: value };
    case "open_questions":
      if (typeof value !== "string") throw invalid("question text, as a string");
      return { field: "open_question", proposedValue: value };
    case "decisions":
      if (typeof value !== "string") throw invalid("the decision text, as a string");
      return { field: "decision", proposedValue: value };
    case "constraints":
      // Approval appends one constraint; lists can't be replaced.
      if (typeof value === "string") return { field: "constraint", proposedValue: value };
      throw invalid(
        "one new constraint, as a string: approval appends it, and existing constraints can't be removed through a proposal",
      );
    case "ownership":
      // Convex checks that the owner is a current member, now and on approval.
      if (value && typeof value === "object") return { field: "ownership", proposedValue: value.area, ownerUserId: value.owner_user_id };
      throw invalid("{ area, owner_user_id }, where owner_user_id is a workspace member");
  }
}
