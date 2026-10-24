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
  mimeType: string;
  version: number;
  updatedAt: number;
  updatedBy: Actor;
}

type Field = Doc<"context_proposals">["field"];

interface ProposalRow {
  id: string;
  workspaceId: string;
  field: Field;
  proposedValue: string;
  rationale: string;
  sourceFileIds: string[];
  status: "pending" | "approved" | "rejected" | "stale";
  createdBy: Actor;
  createdAt: number;
  decidedBy: Actor | null;
  decidedAt: number | null;
  ownerUserId: string | null;
  ownerArea: string | null;
}

interface ContextEntry {
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
  | "INVALID_INPUT";

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
  expectedVersion?: number;
  workspaceId?: string;
}

function codeOf(err: ConvexError<Value>): string | undefined {
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
      const fileId = str("fileId") ?? hint.fileId ?? "(unknown)";
      const current = num("currentVersion") ?? 0;
      const expected = num("expectedVersion") ?? hint.expectedVersion ?? 0;
      return new ToolError(
        "VERSION_CONFLICT",
        `File ${fileId} is at version ${current}, not ${expected}; someone else changed it. ` +
          `Re-read the file with read_file, merge your changes into the latest content, ` +
          `then retry update_document with expected_version=${current}.`,
        { file_id: fileId, current_version: current, expected_version: expected },
      );
    }
    case "NAME_EXISTS": {
      const fileId = str("fileId") ?? "";
      const name = str("name") ?? "";
      const current = num("currentVersion") ?? 1;
      // The name is untrusted workspace data, so quote it rather than splicing it into the sentence.
      return new ToolError(
        "NAME_EXISTS",
        `A file named ${JSON.stringify(name)} already exists (file_id ${fileId}, version ${current}). ` +
          `Read it with read_file. If it is the same document, merge your changes into it with update_document; ` +
          `otherwise choose a different name or ask the user.`,
        { file_id: fileId, name, current_version: current },
      );
    }
    case "APPROVAL_REQUIRED":
      return approvalRequired(str("field") ?? "context");
    case "INVALID_CURSOR":
      return invalidCursor();
    case "INVALID_NAME":
      return invalidInput("name must contain 1–255 visible characters.");
    case "INVALID_PARENT_FOLDER":
      return invalidInput(
        "parent_id must be a folder in this workspace; omit it to create at the top level.",
      );
    case "INVALID_INPUT":
    case "PROPOSAL_NOT_FOUND":
    case "PROPOSAL_ALREADY_DECIDED":
    case "CONTEXT_NOT_INITIALIZED":
      return invalidInput(`Invalid request (${code}).`, data);
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
    mime_type: f.mimeType,
    version: f.version,
    updated_at: iso(f.updatedAt),
    updated_by: toAttribution(f.updatedBy),
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
    proposed_value:
      p.field === "ownership" && p.ownerUserId !== null && p.ownerArea !== null
        ? { area: p.ownerArea, owner_user_id: p.ownerUserId }
        : p.proposedValue,
    rationale: p.rationale,
    source_ids: p.sourceFileIds,
    status: p.status,
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

function toContext(c: ContextRow) {
  return {
    goal: c.goal?.text ?? "",
    scope: c.scope?.text ?? "",
    constraints: c.constraints.map((e) => e.text),
    // Decisions and open questions are append-only, so the position is a stable id.
    decisions: c.decisions.map((e, i) => ({
      id: `decision_${i + 1}`,
      text: e.text,
      status: "approved" as const,
      decided_at: iso(e.updatedAt),
      source_ids: e.sourceFileIds,
    })),
    ownership: c.ownership.map((e) => {
      if (e.ownerUserId !== null && e.ownerArea !== null)
        return { area: e.ownerArea, owner_user_id: e.ownerUserId };
      // Legacy free-text entry ("area: owner").
      const sep = e.text.lastIndexOf(": ");
      return sep > 0
        ? { area: e.text.slice(0, sep), owner_user_id: e.text.slice(sep + 2) }
        : { area: e.text, owner_user_id: "" };
    }),
    open_questions: c.openQuestions.map((e, i) => ({
      id: `question_${i + 1}`,
      text: e.text,
      created_at: iso(e.updatedAt),
      created_by: toAttribution(e.updatedBy),
    })),
    updated_at: iso(c.updatedAt),
    updated_by: toAttribution(c.updatedBy),
  };
}

export function toSyncResult(r: {
  workspace: { id: string; name: string };
  context: ContextRow;
  pendingProposals: Pick<ProposalRow, "id" | "field" | "rationale" | "createdBy" | "createdAt">[];
  changedFiles: FileRow[];
  filesTruncated: boolean;
  recentWork: Parameters<typeof toPublished>[0][];
  workTruncated: boolean;
  events: EventRow[];
  eventsTruncated: boolean;
  cursorSeq: number;
}) {
  return {
    workspace: r.workspace,
    context: toContext(r.context),
    context_version: r.context.revision,
    pending_proposals: r.pendingProposals.map((p) => ({
      id: p.id,
      field: toProposalField(p.field),
      rationale: p.rationale,
      proposed_by: toAttribution(p.createdBy),
      created_at: iso(p.createdAt),
    })),
    changed_files: r.changedFiles.map(toFile),
    files_truncated: r.filesTruncated,
    recent_work: r.recentWork.map(toPublished),
    work_truncated: r.workTruncated,
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
    cursor: encodeCursor(r.workspace.id, r.cursorSeq),
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

type ContextField = "goal" | "scope" | "constraints" | "decisions" | "ownership";
type ProposedValue = string | { area: string; owner_user_id: string };

/** Convex's context model is canonical: one text value per proposal (plus the owner for ownership). */
export function toBackendProposal(
  field: ContextField,
  value: ProposedValue,
): { field: Field; proposedValue: string; ownerUserId?: string } {
  const invalid = (expected: string) =>
    invalidInput(`proposed_value for ${field} must be ${expected}.`, { field });
  switch (field) {
    case "goal":
    case "scope":
      if (typeof value !== "string") throw invalid("the full new text, as a string");
      return { field, proposedValue: value };
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
      if (typeof value === "object") return { field: "ownership", proposedValue: value.area, ownerUserId: value.owner_user_id };
      throw invalid("{ area, owner_user_id }, where owner_user_id is a workspace member");
  }
}
