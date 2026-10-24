import { ConvexHttpClient } from "convex/browser";
import {
  makeFunctionReference,
  type FunctionReference,
} from "convex/server";
import { ConvexError, type Value } from "convex/values";
import {
  TandemError,
  approvalRequired,
  fileNotFound,
  folderNameExists,
  forbidden,
  invalidCursor,
  invalidFolderFilter,
  invalidParentFolder,
  moveConflict,
  moveNameExists,
  nameExists,
  versionConflict,
} from "../errors.js";
import { encodeCursor } from "./cursor.js";
import { folderPathResolver } from "./folders.js";
import type {
  Actor,
  AgentConnection,
  Attribution,
  ContextProposal,
  CreateDocumentInput,
  CreateFolderInput,
  FileMetadata,
  FileVersions,
  FileWithContent,
  FileWithPath,
  FolderMetadata,
  FolderWithPath,
  GetApprovalsInput,
  ListFilesInput,
  ListFoldersInput,
  MoveFileInput,
  ProposalField,
  ProposeContextChangeInput,
  PublishWorkInput,
  PublishedWork,
  SearchFilesInput,
  SearchResult,
  StructuredContext,
  SyncInput,
  SyncResult,
  TandemBackend,
  UpdateDocumentInput,
  WorkspaceEvent,
  WorkspaceEventType,
  WorkspaceMember,
  WorkspaceSummary,
} from "./types.js";

// Wire shapes of packages/backend/convex/mcp.ts (camelCase, epoch ms). Kept
// local so this package doesn't typecheck the Convex sources.
interface ConvexActor {
  type: "human" | "agent" | "system";
  userId?: string;
  agentConnectionId?: string;
  label: string;
  client?: string;
  userName?: string;
}

interface ConvexFile {
  id: string;
  workspaceId: string;
  parentId: string | null;
  name: string;
  mimeType: string;
  version: number;
  updatedAt: number;
  updatedBy: ConvexActor;
}

/** What mcp:listFiles, mcp:searchFiles and mcp:readFile return per file. */
interface ConvexAgentFile extends ConvexFile {
  folderPath: string;
}

interface ConvexFolder {
  id: string;
  workspaceId: string;
  parentId: string | null;
  name: string;
  revision: number;
  updatedAt: number;
  updatedBy: ConvexActor;
}

type ConvexField =
  | "goal"
  | "scope"
  | "constraint"
  | "decision"
  | "ownership"
  | "open_question";

interface ConvexProposal {
  id: string;
  workspaceId: string;
  field: ConvexField;
  proposedValue: string;
  rationale: string;
  sourceFileIds: string[];
  status: "pending" | "approved" | "rejected" | "stale";
  createdBy: ConvexActor;
  createdAt: number;
  decidedBy: ConvexActor | null;
  decidedAt: number | null;
  ownerUserId: string | null;
  ownerArea: string | null;
}

interface ConvexContextEntry {
  text: string;
  sourceFileIds: string[];
  updatedAt: number;
  updatedBy: ConvexActor;
}

interface ConvexContext {
  goal: ConvexContextEntry | null;
  scope: ConvexContextEntry | null;
  constraints: ConvexContextEntry[];
  decisions: ConvexContextEntry[];
  /** Owner fields are null only on entries approved before owners were structured. */
  ownership: (ConvexContextEntry & { ownerUserId: string | null; ownerArea: string | null })[];
  openQuestions: ConvexContextEntry[];
  revision: number;
  updatedAt: number;
  updatedBy: ConvexActor;
}

interface ConvexEvent {
  id: string;
  seq: number;
  kind: string;
  entityType: string;
  entityId: string;
  summary: string;
  actor: ConvexActor;
  createdAt: number;
}

type Token = { token: string };
type WorkspaceArg = { workspaceId?: string };
type Mutation<Args, Ret> = FunctionReference<"mutation", "public", Token & Args, Ret>;

const fn = {
  verifyToken: makeFunctionReference<
    "query",
    Token,
    { userId: string; userName: string; client: string; connectionId: string; workspaceId: string }
  >("mcp:verifyToken"),
  touchConnection: makeFunctionReference<"mutation", Token, null>("mcp:touchConnection"),
  listWorkspaces: makeFunctionReference<"mutation", Token, {
    id: string;
    name: string;
    role: WorkspaceSummary["role"];
    memberCount: number;
    isDefault: boolean;
  }[]>("mcp:listWorkspaces"),
  listMembers: makeFunctionReference<"mutation", Token, {
    members: { userId: string; name: string; role: WorkspaceSummary["role"] }[];
    truncated: boolean;
  }>("mcp:listMembers"),
  getConnection: makeFunctionReference<"mutation", Token, {
    client: string;
    lastMcpActionAt: number | null;
    lastSyncAt: number | null;
  }>("mcp:getConnection"),
  listFiles: makeFunctionReference("mcp:listFiles") as Mutation<
    WorkspaceArg & { folderId?: string; query?: string },
    { files: ConvexAgentFile[]; truncated: boolean }
  >,
  searchFiles: makeFunctionReference("mcp:searchFiles") as Mutation<
    WorkspaceArg & { query: string; limit: number },
    { file: ConvexAgentFile; snippet: string; match: "name" | "content" }[]
  >,
  readFile: makeFunctionReference("mcp:readFile") as Mutation<
    { fileId: string },
    { file: ConvexAgentFile; content: string | null }
  >,
  getFileVersions: makeFunctionReference("mcp:getFileVersions") as Mutation<
    { fileId: string; limit: number },
    {
      file: ConvexFile;
      versions: { version: number; createdAt: number; actor: ConvexActor; sizeBytes: number }[];
    }
  >,
  createDocument: makeFunctionReference("mcp:createDocument") as Mutation<
    WorkspaceArg & { parentId?: string; name: string; mimeType: string; content: string },
    ConvexFile
  >,
  updateDocument: makeFunctionReference("mcp:updateDocument") as Mutation<
    { fileId: string; content: string; expectedVersion: number },
    ConvexFile
  >,
  createFolder: makeFunctionReference("mcp:createFolder") as Mutation<
    WorkspaceArg & { parentId?: string; name: string },
    ConvexFolder
  >,
  listFolders: makeFunctionReference("mcp:listFolders") as Mutation<
    WorkspaceArg,
    { folders: ConvexFolder[]; truncated: boolean }
  >,
  moveFile: makeFunctionReference("mcp:moveFile") as Mutation<
    { fileId: string; parentId: string | null; expectedVersion: number },
    ConvexFile
  >,
  syncWorkspace: makeFunctionReference("mcp:syncWorkspace") as Mutation<
    WorkspaceArg & { sinceSeq?: number; cursorWorkspaceId?: string },
    {
      workspace: { id: string; name: string };
      context: ConvexContext;
      pendingProposals: Pick<ConvexProposal, "id" | "field" | "rationale" | "createdBy" | "createdAt">[];
      changedFiles: ConvexFile[];
      filesTruncated: boolean;
      events: ConvexEvent[];
      eventsTruncated: boolean;
      headSeq: number;
      cursorSeq: number;
    }
  >,
  proposeContextChange: makeFunctionReference("mcp:proposeContextChange") as Mutation<
    WorkspaceArg & {
      field: ConvexField;
      proposedValue: string;
      ownerUserId?: string;
      rationale: string;
      sourceFileIds: string[];
    },
    { proposal: ConvexProposal; contextRevision: number }
  >,
  getApprovals: makeFunctionReference("mcp:getApprovals") as Mutation<
    WorkspaceArg & { status?: ConvexProposal["status"]; limit: number },
    { proposal: ConvexProposal; contextRevision: number }[]
  >,
  publishWork: makeFunctionReference("mcp:publishWork") as Mutation<
    WorkspaceArg & {
      kind: PublishedWork["kind"];
      title: string;
      summary: string;
      fileIds: string[];
    },
    {
      id: string;
      workspaceId: string;
      kind: PublishedWork["kind"];
      title: string;
      summary: string;
      fileIds: string[];
      createdBy: ConvexActor;
      createdAt: number;
    }
  >,
};

/**
 * TandemBackend over the Convex deployment at `url`. Holds no admin key:
 * every call forwards the caller's agent token and Convex authorizes it.
 */
export class ConvexBackend implements TandemBackend {
  readonly kind = "convex";
  private readonly client: Pick<ConvexHttpClient, "query" | "mutation">;

  /** `client` is for tests; production passes the deployment URL. */
  constructor(urlOrClient: string | Pick<ConvexHttpClient, "query" | "mutation">) {
    this.client =
      typeof urlOrClient === "string"
        ? new ConvexHttpClient(urlOrClient, { logger: false })
        : urlOrClient;
  }

  /** Verifies a token with Convex; null when Convex rejects it. */
  async verifyToken(token: string) {
    try {
      return await this.client.query(fn.verifyToken, { token });
    } catch (err) {
      if (
        err instanceof ConvexError &&
        ["UNAUTHENTICATED", "FORBIDDEN"].includes(codeOf(err) ?? "")
      )
        return null;
      throw err;
    }
  }

  async listWorkspaces(actor: Actor): Promise<WorkspaceSummary[]> {
    const rows = await this.call(actor, fn.listWorkspaces, {});
    return rows.map((w) => ({
      id: w.id,
      name: w.name,
      role: w.role,
      member_count: w.memberCount,
      is_default: w.isDefault,
    }));
  }

  async listMembers(
    actor: Actor,
  ): Promise<{ members: WorkspaceMember[]; truncated: boolean }> {
    const r = await this.call(actor, fn.listMembers, {});
    return {
      members: r.members.map((m) => ({ user_id: m.userId, name: m.name, role: m.role })),
      truncated: r.truncated,
    };
  }

  async getConnection(actor: Actor): Promise<AgentConnection> {
    const c = await this.call(actor, fn.getConnection, {});
    return {
      client: c.client,
      last_synced_at: iso(c.lastSyncAt),
      last_action_at: iso(c.lastMcpActionAt),
    };
  }

  async listFiles(actor: Actor, input: ListFilesInput): Promise<FileWithPath[]> {
    const { files } = await this.call(actor, fn.listFiles, {
      workspaceId: input.workspace_id,
      folderId: input.folder_id,
      query: input.query,
    });
    return files.map(toFileWithPath);
  }

  async searchFiles(actor: Actor, input: SearchFilesInput): Promise<SearchResult[]> {
    const rows = await this.call(actor, fn.searchFiles, {
      workspaceId: input.workspace_id,
      query: input.query,
      limit: input.limit,
    });
    return rows.map((r) => ({
      file: toFileWithPath(r.file),
      snippet: r.snippet,
      match: r.match,
    }));
  }

  async readFile(actor: Actor, fileId: string): Promise<FileWithContent> {
    const { file, content } = await this.call(actor, fn.readFile, { fileId }, { fileId });
    if (content === null) {
      // Binary uploads have no text content; don't pretend they're empty.
      throw new TandemError(
        "INVALID_INPUT",
        `File ${fileId} (${file.mimeType}) is not a text document. Ask the user to open it in the Tandem dashboard.`,
        { file_id: fileId, mime_type: file.mimeType },
      );
    }
    return { file: toFileWithPath(file), content };
  }

  async getFileVersions(actor: Actor, fileId: string, limit: number): Promise<FileVersions> {
    const r = await this.call(actor, fn.getFileVersions, { fileId, limit }, { fileId });
    return {
      file: toFile(r.file),
      versions: r.versions.map((v) => ({
        version: v.version,
        created_at: isoRequired(v.createdAt),
        author: toAttribution(v.actor),
        size_bytes: v.sizeBytes,
      })),
    };
  }

  async createDocument(actor: Actor, input: CreateDocumentInput): Promise<FileMetadata> {
    const file = await this.call(actor, fn.createDocument, {
      workspaceId: input.workspace_id,
      parentId: input.parent_id,
      name: input.name,
      mimeType: input.mime_type,
      content: input.content,
    });
    return toFile(file);
  }

  async updateDocument(actor: Actor, input: UpdateDocumentInput): Promise<FileMetadata> {
    const file = await this.call(
      actor,
      fn.updateDocument,
      {
        fileId: input.file_id,
        content: input.content,
        expectedVersion: input.expected_version,
      },
      { fileId: input.file_id, expectedVersion: input.expected_version },
    );
    return toFile(file);
  }

  async createFolder(actor: Actor, input: CreateFolderInput): Promise<FolderMetadata> {
    const folder = await this.call(actor, fn.createFolder, {
      workspaceId: input.workspace_id,
      parentId: input.parent_id,
      name: input.name,
    });
    return toFolder(folder);
  }

  async listFolders(
    actor: Actor,
    input: ListFoldersInput,
  ): Promise<{ folders: FolderWithPath[]; truncated: boolean }> {
    const r = await this.call(actor, fn.listFolders, { workspaceId: input.workspace_id });
    const folders = r.folders.map(toFolder);
    const pathOf = folderPathResolver(folders);
    return {
      folders: folders.map((f) => ({ ...f, path: pathOf(f.id) })),
      truncated: r.truncated,
    };
  }

  async moveFile(actor: Actor, input: MoveFileInput): Promise<FileMetadata> {
    const file = await this.call(
      actor,
      fn.moveFile,
      {
        fileId: input.file_id,
        // null is meaningful here (the top level), so stripUndefined keeps it.
        parentId: input.parent_id,
        expectedVersion: input.expected_version,
      },
      { fileId: input.file_id, expectedVersion: input.expected_version, move: true },
    );
    return toFile(file);
  }

  async syncWorkspace(actor: Actor, input: SyncInput): Promise<SyncResult> {
    const since = input.since === undefined ? undefined : parseCursor(input.since);
    const r = await this.call(actor, fn.syncWorkspace, {
      workspaceId: input.workspace_id,
      sinceSeq: since?.seq,
      cursorWorkspaceId: since?.workspaceId,
    });
    return {
      workspace: r.workspace,
      context: toContext(r.context),
      context_version: r.context.revision,
      pending_proposals: r.pendingProposals.map((p) => ({
        id: p.id,
        field: toProposalField(p.field),
        rationale: p.rationale,
        proposed_by: toAttribution(p.createdBy),
        created_at: isoRequired(p.createdAt),
      })),
      changed_files: r.changedFiles.map(toFile),
      files_truncated: r.filesTruncated,
      events: r.events.map((e) => toEvent(r.workspace.id, e)),
      events_truncated: r.eventsTruncated,
      cursor: encodeCursor(r.workspace.id, r.cursorSeq),
    };
  }

  async proposeContextChange(
    actor: Actor,
    input: ProposeContextChangeInput,
  ): Promise<ContextProposal> {
    const r = await this.call(actor, fn.proposeContextChange, {
      workspaceId: input.workspace_id,
      ...toConvexProposal(input),
      rationale: input.rationale,
      sourceFileIds: input.source_ids ?? [],
    });
    return toProposal(r.proposal, r.contextRevision);
  }

  async getApprovals(actor: Actor, input: GetApprovalsInput): Promise<ContextProposal[]> {
    const rows = await this.call(actor, fn.getApprovals, {
      workspaceId: input.workspace_id,
      status: input.status === "all" ? undefined : input.status,
      limit: input.limit,
    });
    return rows.map((r) => toProposal(r.proposal, r.contextRevision));
  }

  async publishWork(actor: Actor, input: PublishWorkInput): Promise<PublishedWork> {
    const w = await this.call(actor, fn.publishWork, {
      workspaceId: input.workspace_id,
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      fileIds: input.file_ids ?? [],
    });
    return {
      id: w.id,
      workspace_id: w.workspaceId,
      kind: w.kind,
      title: w.title,
      summary: w.summary,
      file_ids: w.fileIds,
      published_by: toAttribution(w.createdBy),
      created_at: isoRequired(w.createdAt),
    };
  }

  async decideProposal(): Promise<ContextProposal> {
    // Human-only, in the dashboard; Convex rejects agent callers itself.
    throw new TandemError(
      "FORBIDDEN",
      "Only a human workspace owner or admin can approve or reject proposals, in the Tandem dashboard.",
    );
  }

  async applyContextChange(
    _actor: Actor,
    input: { field: string },
  ): Promise<{ context: StructuredContext; context_version: number }> {
    throw approvalRequired(input.field);
  }

  private async call<Args extends object, Ret>(
    actor: Actor,
    ref: FunctionReference<"mutation", "public", Token & Args, Ret>,
    args: Args,
    hint: ErrorHint = {},
  ): Promise<Ret> {
    if (!actor.credential) {
      throw new TandemError("UNAUTHENTICATED", "Missing agent token.");
    }
    try {
      // skipQueue: the client is shared by concurrent requests, and the
      // default queue would serialize every caller's mutations.
      return (await this.client.mutation(
        ref as FunctionReference<"mutation">,
        { ...stripUndefined(args), token: actor.credential },
        { skipQueue: true },
      )) as Ret;
    } catch (err) {
      await this.recordFailedAction(actor.credential, err);
      throw toTandemError(err, hint, args as WorkspaceArg);
    }
  }

  /**
   * A failed tool mutation rolls back its own presence touch, so record "last
   * MCP action" separately. Only after failures (successes already recorded
   * it), only for errors Convex raised past token checks, and never fatal.
   */
  private async recordFailedAction(token: string, err: unknown): Promise<void> {
    if (!(err instanceof ConvexError) || codeOf(err) === "UNAUTHENTICATED") return;
    try {
      await this.client.mutation(fn.touchConnection, { token }, { skipQueue: true });
    } catch {
      // Presence is best effort; the caller gets the original error.
    }
  }
}

interface ErrorHint {
  fileId?: string;
  expectedVersion?: number;
  /** The call was a move_file, which has its own recovery copy. */
  move?: boolean;
}

function codeOf(err: ConvexError<Value>): string | undefined {
  const data = err.data as { code?: unknown } | string;
  if (typeof data === "string") return data;
  return typeof data?.code === "string" ? data.code : undefined;
}

/** Maps Convex error codes to the MCP tool contract (see docs/mvp-integration.md). */
export function toTandemError(
  err: unknown,
  hint: ErrorHint,
  args: WorkspaceArg,
): unknown {
  if (!(err instanceof ConvexError)) return err;
  const code = codeOf(err);
  const data = (typeof err.data === "object" && err.data ? err.data : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof data[k] === "string" ? (data[k] as string) : undefined);
  const num = (k: string) => (typeof data[k] === "number" ? (data[k] as number) : undefined);
  switch (code) {
    case "UNAUTHENTICATED":
      return new TandemError(
        "UNAUTHENTICATED",
        "This agent connection is invalid or was revoked. Ask the user to reconnect Tandem.",
      );
    case "FORBIDDEN":
    case "WORKSPACE_NOT_FOUND":
      return forbidden(str("workspaceId") ?? args.workspaceId ?? "(this workspace)");
    case "FILE_NOT_FOUND":
    case "INVALID_SOURCE_FILE":
      return fileNotFound(str("fileId") ?? hint.fileId ?? "(unknown)");
    case "VERSION_CONFLICT":
      return (hint.move ? moveConflict : versionConflict)(
        str("fileId") ?? hint.fileId ?? "(unknown)",
        num("currentVersion") ?? 0,
        num("expectedVersion") ?? hint.expectedVersion ?? 0,
      );
    case "NAME_EXISTS": {
      const folderId = str("folderId");
      if (folderId !== undefined) return folderNameExists(folderId, str("name") ?? "");
      return (hint.move ? moveNameExists : nameExists)(
        str("fileId") ?? "",
        str("name") ?? "",
        num("currentVersion") ?? 1,
      );
    }
    case "APPROVAL_REQUIRED":
      return approvalRequired(str("field") ?? "context");
    case "INVALID_CURSOR":
      return invalidCursor();
    case "INVALID_NAME":
      return new TandemError("INVALID_INPUT", "name must contain 1–255 visible characters.");
    case "INVALID_PARENT_FOLDER":
      return invalidParentFolder(hint.move);
    case "INVALID_INPUT":
      if (str("field") === "folderId") return invalidFolderFilter();
      return new TandemError("INVALID_INPUT", `Invalid request (${code}).`, data);
    case "PROPOSAL_NOT_FOUND":
    case "PROPOSAL_ALREADY_DECIDED":
    case "CONTEXT_NOT_INITIALIZED":
      return new TandemError("INVALID_INPUT", `Invalid request (${code}).`, data);
    default:
      return err;
  }
}

/** Convex's context model is canonical: one text value per proposal (plus the owner for ownership). */
function toConvexProposal(input: ProposeContextChangeInput): {
  field: ConvexField;
  proposedValue: string;
  ownerUserId?: string;
} {
  const value = input.proposed_value;
  const invalid = (expected: string) =>
    new TandemError("INVALID_INPUT", `proposed_value for ${input.field} must be ${expected}.`, {
      field: input.field,
    });
  switch (input.field) {
    case "goal":
    case "scope":
      if (typeof value !== "string") throw invalid("the full new text, as a string");
      return { field: input.field, proposedValue: value };
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
      if (value && typeof value === "object" && !Array.isArray(value))
        return { field: "ownership", proposedValue: value.area, ownerUserId: value.owner_user_id };
      throw invalid("{ area, owner_user_id }, where owner_user_id is a workspace member");
  }
}

function toProposalField(field: ConvexField): ProposalField {
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

function toProposal(p: ConvexProposal, contextRevision: number): ContextProposal {
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
    created_at: isoRequired(p.createdAt),
    ...(p.decidedBy && p.decidedAt !== null
      ? {
          decided_by: { user_id: p.decidedBy.userId ?? "", actor_type: "human" as const },
          decided_at: isoRequired(p.decidedAt),
        }
      : {}),
  };
}

function toContext(c: ConvexContext): StructuredContext {
  return {
    goal: c.goal?.text ?? "",
    scope: c.scope?.text ?? "",
    constraints: c.constraints.map((e) => e.text),
    // Decisions and open questions are append-only, so the position is a stable id.
    decisions: c.decisions.map((e, i) => ({
      id: `decision_${i + 1}`,
      text: e.text,
      status: "approved" as const,
      decided_at: isoRequired(e.updatedAt),
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
      created_at: isoRequired(e.updatedAt),
      created_by: toAttribution(e.updatedBy),
    })),
    updated_at: isoRequired(c.updatedAt),
    updated_by: toAttribution(c.updatedBy),
  };
}

function toEvent(workspaceId: string, e: ConvexEvent): WorkspaceEvent {
  return {
    seq: e.seq,
    workspace_id: workspaceId,
    type: e.kind as WorkspaceEventType,
    subject_id: e.entityId,
    actor: toAttribution(e.actor),
    at: isoRequired(e.createdAt),
    summary: e.summary,
  };
}

function toFile(f: ConvexFile): FileMetadata {
  return {
    id: f.id,
    workspace_id: f.workspaceId,
    parent_id: f.parentId,
    name: f.name,
    mime_type: f.mimeType,
    version: f.version,
    updated_at: isoRequired(f.updatedAt),
    updated_by: toAttribution(f.updatedBy),
  };
}

function toFileWithPath(f: ConvexAgentFile): FileWithPath {
  return { ...toFile(f), folder_path: f.folderPath };
}

function toFolder(f: ConvexFolder): FolderMetadata {
  return {
    id: f.id,
    workspace_id: f.workspaceId,
    parent_id: f.parentId,
    name: f.name,
    revision: f.revision,
    updated_at: isoRequired(f.updatedAt),
    updated_by: toAttribution(f.updatedBy),
  };
}

export function toAttribution(a: ConvexActor): Attribution {
  const agent = a.type === "agent";
  return {
    actor_type: agent ? "agent" : "human",
    user_id: a.userId ?? "",
    client: a.client ?? (a.type === "system" ? "system" : agent ? "agent" : "dashboard"),
    ...(a.agentConnectionId ? { agent_connection_id: a.agentConnectionId } : {}),
    label: a.label,
  };
}

/** Same base64url JSON as cursor.ts; Convex checks the seq against its head. */
function parseCursor(cursor: string): { workspaceId: string; seq: number } {
  try {
    const { w, s } = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      w?: unknown;
      s?: unknown;
    };
    if (typeof w === "string" && typeof s === "number" && Number.isSafeInteger(s) && s >= 0)
      return { workspaceId: w, seq: s };
  } catch {
    // Fall through.
  }
  throw invalidCursor();
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function isoRequired(ms: number): string {
  return new Date(ms).toISOString();
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T;
}
