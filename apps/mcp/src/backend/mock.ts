import { randomUUID } from "node:crypto";
import {
  TandemError,
  approvalRequired,
  fileNotFound,
  folderNameExists,
  folderNotFound,
  folderTooDeep,
  forbidden,
  invalidPath,
  nameExists,
  pathNotFound,
  versionAhead,
  versionConflict,
} from "../errors.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { MAX_NAME_LENGTH, isValidName, nameKey, storedName } from "../names.js";
import type {
  Actor,
  AgentConnection,
  WorkspaceMember,
  ApplyContextChangeInput,
  Attribution,
  ContextEntry,
  ContextField,
  ContextProposal,
  CreateDocumentInput,
  CreateFolderInput,
  CreateFolderResult,
  FileMetadata,
  FolderMetadata,
  FileVersions,
  FileWithContent,
  GetApprovalsInput,
  ListFilesInput,
  ListFilesResult,
  MoveFileInput,
  MoveFolderInput,
  Ownership,
  ProposeContextChangeInput,
  ProposedValue,
  PublishWorkInput,
  PublishedWork,
  ReadFileInput,
  SearchFilesInput,
  SearchResult,
  StructuredContext,
  SyncInput,
  SyncResult,
  TandemBackend,
  UpdateDocumentInput,
  WorkspaceEvent,
  WorkspaceEventType,
  WorkspaceRole,
  WorkspaceSummary,
} from "./types.js";

function contextEntry(
  text: string,
  id = `entry_${randomUUID()}`,
  updatedBy: Attribution = {
    actor_type: "human",
    user_id: "user_alex",
    client: "dashboard",
  },
  sourceIds: string[] = [],
): ContextEntry {
  return {
    id,
    text,
    source_ids: [...sourceIds],
    updated_at: new Date().toISOString(),
    updated_by: updatedBy,
    status: "active",
    resolved_by: null,
    resolved_at: null,
    superseded_by: null,
  };
}

interface StoredWorkspace {
  name: string;
  members: Map<string, WorkspaceRole>;
  context: StructuredContext;
  context_version: number;
  /** seq N is at index N-1. */
  events: WorkspaceEvent[];
}

interface Revision {
  version: number;
  content: string;
  created_at: string;
  created_by: Attribution;
}

interface StoredFile {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  name: string;
  mime_type: string;
  revisions: Revision[];
}

interface StoredFolder {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  name: string;
  revision: number;
  updated_at: string;
}

/** Where a path points (docs/filesystem.md `resolvePath`). */
type Resolved =
  | { kind: "root" }
  | { kind: "folder"; folder: StoredFolder }
  | { kind: "file"; file: StoredFile };

const SEED_BRIEF = `# Project brief

Goal: ship the Tandem demo for Cal Hacks.
`;

/** Max files and events per sync_workspace call. */
const SYNC_LIMIT = 50;
const SYNC_WORK_LIMIT = 20;
const SYNC_FOLDER_LIMIT = 200;
/** Max folders and max files per list_files call. */
const LIST_LIMIT = 500;
/** Max nested folders below the root. */
const MAX_FOLDER_DEPTH = 32;

/** In-memory backend for local development and tests. State is lost on restart. */
export class MockBackend implements TandemBackend {
  readonly kind = "mock";
  // Insertion order matters: an actor's first workspace is their default.
  private readonly workspaces = new Map<string, StoredWorkspace>();
  private readonly files = new Map<string, StoredFile>();
  private readonly folders = new Map<string, StoredFolder>();
  // Insertion order is creation order, so reversing gives newest first.
  private readonly proposals = new Map<string, ContextProposal>();
  private readonly published = new Map<string, PublishedWork>();
  /** Keyed by user id and client. */
  private readonly connections = new Map<string, AgentConnection>();

  constructor() {
    const now = new Date().toISOString();
    const alex: Attribution = {
      actor_type: "human",
      user_id: "user_alex",
      client: "dashboard",
    };
    const sam: Attribution = { ...alex, user_id: "user_sam" };
    const jordan: Attribution = { ...alex, user_id: "user_jordan" };

    this.workspaces.set("ws_demo", {
      name: "Demo workspace",
      members: new Map([
        ["user_alex", "owner"],
        ["user_sam", "member"],
        ["user_taylor", "admin"],
      ]),
      context: {
        goal: "Ship a working Tandem demo at Cal Hacks 13.0: two teammates, each in their own assistant, editing one canonical brief without losing work.",
        scope:
          "One shared workspace with files, revisions, approvals, and a remote MCP server for Claude and ChatGPT. No real-time co-editing and no agent-to-agent messaging.",
        constraints: [
          contextEntry("Submissions are due Oct 25, 9 AM PT."),
          contextEntry(
            "Every write carries expected_version; stale writes fail with VERSION_CONFLICT.",
          ),
        ],
        decisions: [
          {
            ...contextEntry(
              "Use Convex for the database, auth, and file storage.",
              "dec_convex",
            ),
            decided_at: now,
            source_ids: ["file_brief"],
          },
        ],
        ownership: [
          {
            ...contextEntry("MCP server"),
            area: "MCP server",
            owner_user_id: "user_alex",
          },
        ],
        open_questions: [],
        updated_at: now,
        updated_by: alex,
      },
      context_version: 1,
      events: [],
    });
    this.workspaces.set("ws_other", {
      name: "Other workspace",
      members: new Map([["user_jordan", "owner"]]),
      context: {
        goal: "Plan the spring community meetup.",
        scope: "Venue, speakers, and budget for a single evening event.",
        constraints: [
          contextEntry("Total budget under $2,000.", undefined, jordan),
        ],
        decisions: [],
        ownership: [
          {
            ...contextEntry("Venue", undefined, jordan),
            area: "Venue",
            owner_user_id: "user_jordan",
          },
        ],
        open_questions: [],
        updated_at: now,
        updated_by: jordan,
      },
      context_version: 1,
      events: [],
    });

    this.files.set("file_brief", {
      id: "file_brief",
      workspace_id: "ws_demo",
      parent_id: null,
      name: "brief.md",
      mime_type: "text/markdown",
      revisions: [
        { version: 1, content: SEED_BRIEF, created_at: now, created_by: sam },
      ],
    });
    this.appendEvent(
      "ws_demo",
      "file.created",
      "file_brief",
      sam,
      "brief.md created",
    );
  }

  async listWorkspaces(actor: Actor): Promise<WorkspaceSummary[]> {
    const mine = [...this.workspaces].filter(([, ws]) =>
      ws.members.has(actor.user_id),
    );
    return mine.map(([id, ws], i) => ({
      id,
      name: ws.name,
      role: ws.members.get(actor.user_id)!,
      member_count: ws.members.size,
      is_default: i === 0,
    }));
  }

  async listMembers(
    actor: Actor,
  ): Promise<{ members: WorkspaceMember[]; truncated: boolean }> {
    // The default workspace is the actor's first one (see listWorkspaces).
    const ws = [...this.workspaces.values()].find((w) =>
      w.members.has(actor.user_id),
    );
    const members = [...(ws?.members ?? [])].map(([user_id, role]) => ({
      user_id,
      name: mockName(user_id),
      role,
    }));
    return { members: members.slice(0, 100), truncated: members.length > 100 };
  }

  async getConnection(actor: Actor): Promise<AgentConnection> {
    const c = this.connections.get(connectionKey(actor));
    return {
      client: actor.client,
      last_synced_at: c?.last_synced_at ?? null,
      last_action_at: c?.last_action_at ?? null,
    };
  }

  async listFiles(
    actor: Actor,
    input: ListFilesInput,
  ): Promise<ListFilesResult> {
    const workspaceId = this.resolveWorkspace(actor, input.workspace_id);
    const folder = this.folderArg(workspaceId, input.folder_id, input.path, {
      id: "folder_id",
      path: "path",
    });
    const parentId = folder?.id ?? null;
    const query = input.query?.toLowerCase();
    const subtree = query !== undefined || input.recursive === true;
    const inScope = (p: string | null) =>
      subtree ? this.isWithin(p, parentId) : p === parentId;
    const nameMatches = (name: string) =>
      query === undefined || name.toLowerCase().includes(query);

    const folders = [...this.folders.values()]
      .filter(
        (f) =>
          f.workspace_id === workspaceId &&
          inScope(f.parent_id) &&
          nameMatches(f.name),
      )
      .map((f) => this.toFolderMetadata(f));
    const files = [...this.files.values()]
      .filter(
        (f) =>
          f.workspace_id === workspaceId &&
          inScope(f.parent_id) &&
          nameMatches(f.name),
      )
      .map((f) => this.toMetadata(f));
    // Immediate children sort by name; a flattened subtree by path.
    const order = (a: { name: string; path: string }, b: typeof a) =>
      subtree ? a.path.localeCompare(b.path) : a.name.localeCompare(b.name);
    folders.sort(order);
    files.sort(order);
    return {
      folder: { id: parentId, path: this.folderPath(parentId) },
      folders: folders.slice(0, LIST_LIMIT),
      files: files.slice(0, LIST_LIMIT),
      truncated: folders.length > LIST_LIMIT || files.length > LIST_LIMIT,
    };
  }

  async searchFiles(
    actor: Actor,
    input: SearchFilesInput,
  ): Promise<SearchResult[]> {
    const workspaceId = this.resolveWorkspace(actor, input.workspace_id);
    const query = input.query.toLowerCase();
    const results: SearchResult[] = [];
    for (const f of this.files.values()) {
      if (f.workspace_id !== workspaceId) continue;
      const content = head(f).content;
      const nameMatch = f.name.toLowerCase().includes(query);
      const at = content.toLowerCase().indexOf(query);
      if (!nameMatch && at === -1) continue;
      results.push({
        file: this.toMetadata(f),
        snippet:
          at === -1
            ? snippet(content, 0, 0)
            : snippet(content, at, query.length),
        match: nameMatch ? "name" : "content",
      });
    }
    return results
      .sort(
        (a, b) =>
          Number(b.match === "name") - Number(a.match === "name") ||
          b.file.updated_at.localeCompare(a.file.updated_at),
      )
      .slice(0, input.limit);
  }

  async readFile(actor: Actor, input: ReadFileInput): Promise<FileWithContent> {
    if ((input.file_id === undefined) === (input.path === undefined)) {
      throw new TandemError(
        "INVALID_INPUT",
        "Pass exactly one of file_id or path.",
      );
    }
    let file: StoredFile;
    if (input.file_id !== undefined) {
      file = this.getFile(actor, input.file_id);
    } else {
      const workspaceId = this.resolveWorkspace(actor, undefined);
      const found = this.resolvePath(workspaceId, input.path!);
      if (found?.kind !== "file") {
        throw pathNotFound(
          input.path!,
          found
            ? "That path is a folder; call list_files with it to see its contents."
            : "Call list_files to browse folders, or search_files to find the file.",
        );
      }
      file = found.file;
    }
    return { file: this.toMetadata(file), content: head(file).content };
  }

  async getFileVersions(
    actor: Actor,
    fileId: string,
    limit: number,
  ): Promise<FileVersions> {
    const file = this.getFile(actor, fileId);
    const versions = file.revisions
      .slice()
      .reverse()
      .slice(0, limit)
      .map((r) => ({
        version: r.version,
        created_at: r.created_at,
        author: r.created_by,
        size_bytes: Buffer.byteLength(r.content, "utf8"),
      }));
    return { file: this.toMetadata(file), versions };
  }

  async createDocument(
    actor: Actor,
    input: CreateDocumentInput,
  ): Promise<FileMetadata> {
    const workspaceId = this.resolveWorkspace(actor, input.workspace_id);
    const parent = this.folderArg(
      workspaceId,
      input.parent_id,
      input.folder_path,
      { id: "parent_id", path: "folder_path" },
      "Create it first with create_folder.",
    );
    const parentId = parent?.id ?? null;
    const name = validName(input.name);
    // No await between the check and the insert, so this is atomic in Node.
    this.checkNameFree(workspaceId, parentId, name);
    const file: StoredFile = {
      id: `file_${randomUUID()}`,
      workspace_id: workspaceId,
      parent_id: parentId,
      name,
      mime_type: input.mime_type,
      revisions: [newRevision(actor, 1, input.content)],
    };
    this.files.set(file.id, file);
    this.appendEvent(
      workspaceId,
      "file.created",
      file.id,
      attribution(actor),
      `${truncate(file.name, 80)} created`,
    );
    this.touch(actor, "last_action_at");
    return this.toMetadata(file);
  }

  async updateDocument(
    actor: Actor,
    input: UpdateDocumentInput,
  ): Promise<FileMetadata> {
    const file = this.getFile(actor, input.file_id);
    const current = checkVersion(
      file,
      input.expected_version,
      "update_document",
    );
    file.revisions.push(newRevision(actor, current + 1, input.content));
    this.appendEvent(
      file.workspace_id,
      "file.updated",
      file.id,
      attribution(actor),
      `${truncate(file.name, 80)} updated to v${current + 1}`,
    );
    this.touch(actor, "last_action_at");
    return this.toMetadata(file);
  }

  async createFolder(
    actor: Actor,
    input: CreateFolderInput,
  ): Promise<CreateFolderResult> {
    const workspaceId = this.resolveWorkspace(actor, input.workspace_id);
    const segments = parsePath(input.path);
    if (segments.length === 0) {
      throw invalidPath(input.path, "the root folder always exists");
    }
    if (segments.length > MAX_FOLDER_DEPTH) throw folderTooDeep(input.path);
    // Walk the existing prefix first and validate the rest before writing, so a
    // failure leaves nothing half-created (one mutation in Convex).
    let parent: StoredFolder | null = null;
    let i = 0;
    for (; i < segments.length; i++) {
      const child = this.childByKey(
        workspaceId,
        parent?.id ?? null,
        nameKey(segments[i]!),
      );
      if (!child) break;
      if (child.kind === "file") {
        throw nameExists(
          child.file.id,
          child.file.name,
          head(child.file).version,
        );
      }
      parent = child.folder;
    }
    if (i === segments.length) {
      this.touch(actor, "last_action_at");
      return { folder: this.toFolderMetadata(parent!), created: false };
    }
    const names = segments.slice(i).map((s) => validName(s));
    for (const name of names) {
      parent = this.insertFolder(actor, workspaceId, parent?.id ?? null, name);
    }
    this.touch(actor, "last_action_at");
    return { folder: this.toFolderMetadata(parent!), created: true };
  }

  async moveFile(actor: Actor, input: MoveFileInput): Promise<FileMetadata> {
    const file = this.getFile(actor, input.file_id);
    const current = checkVersion(file, input.expected_version, "move_file");
    const dest = this.destinationArg(file.workspace_id, input);
    const parentId = dest?.id ?? null;
    const name =
      input.new_name === undefined ? file.name : validName(input.new_name);
    this.checkNameFree(file.workspace_id, parentId, name, file.id);
    file.parent_id = parentId;
    file.name = name;
    // Same content, new head revision: a move is versioned like an edit.
    file.revisions.push(newRevision(actor, current + 1, head(file).content));
    this.appendEvent(
      file.workspace_id,
      "file.moved",
      file.id,
      attribution(actor),
      `Moved ${truncate(name, 80)} to ${truncate(this.folderPath(parentId), 120)}`,
    );
    this.touch(actor, "last_action_at");
    return this.toMetadata(file);
  }

  async moveFolder(
    actor: Actor,
    input: MoveFolderInput,
  ): Promise<FolderMetadata> {
    const folder = this.getFolder(actor, input.folder_id);
    const expected = input.expected_revision;
    if (!Number.isSafeInteger(expected) || expected < 1) {
      throw new TandemError(
        "INVALID_INPUT",
        "expected_revision must be a positive integer: the folder's revision from list_files or sync_workspace.",
        { folder_id: folder.id, expected_revision: expected },
      );
    }
    if (expected !== folder.revision) {
      throw expected > folder.revision
        ? new TandemError(
            "INVALID_INPUT",
            `expected_revision ${expected} is newer than the folder's current revision ${folder.revision}. ` +
              `Use the revision returned by list_files.`,
            {
              folder_id: folder.id,
              current_revision: folder.revision,
              expected_revision: expected,
            },
          )
        : new TandemError(
            "VERSION_CONFLICT",
            `Folder ${folder.id} is at revision ${folder.revision}, not ${expected}; someone else changed it. ` +
              `Call list_files to see where it is now, then retry move_folder with expected_revision=${folder.revision}.`,
            {
              folder_id: folder.id,
              current_revision: folder.revision,
              expected_revision: expected,
            },
          );
    }
    const dest = this.destinationArg(folder.workspace_id, input);
    const parentId = dest?.id ?? null;
    if (this.isWithin(parentId, folder.id)) {
      throw new TandemError(
        "INVALID_MOVE",
        "A folder can't be moved into itself or one of its own subfolders. Choose a destination outside it.",
        { folder_id: folder.id, to_folder_id: parentId },
      );
    }
    if (this.depthOf(parentId) + this.heightOf(folder) > MAX_FOLDER_DEPTH) {
      throw folderTooDeep(this.folderPath(parentId));
    }
    const name =
      input.new_name === undefined ? folder.name : validName(input.new_name);
    this.checkNameFree(folder.workspace_id, parentId, name, folder.id);
    folder.parent_id = parentId;
    folder.name = name;
    folder.revision += 1;
    folder.updated_at = new Date().toISOString();
    this.appendEvent(
      folder.workspace_id,
      "folder.moved",
      folder.id,
      attribution(actor),
      `Moved folder ${truncate(name, 80)} to ${truncate(this.folderPath(parentId), 120)}`,
    );
    this.touch(actor, "last_action_at");
    return this.toFolderMetadata(folder);
  }

  async syncWorkspace(actor: Actor, input: SyncInput): Promise<SyncResult> {
    const workspaceId = this.resolveWorkspace(actor, input.workspace_id);
    const ws = this.workspaces.get(workspaceId)!;
    const headSeq = ws.events.length;

    let sinceSeq = 0;
    let changed: FileMetadata[];
    let events: WorkspaceEvent[];
    let eventsTruncated: boolean;
    let cursorSeq: number;
    if (input.since === undefined) {
      changed = [...this.files.values()]
        .filter((f) => f.workspace_id === workspaceId)
        .map((f) => this.toMetadata(f));
      events = ws.events.slice(-SYNC_LIMIT);
      eventsTruncated = ws.events.length > SYNC_LIMIT;
      cursorSeq = headSeq;
    } else {
      const since = decodeCursor(input.since, workspaceId, headSeq);
      sinceSeq = since;
      const after = ws.events.filter((e) => e.seq > since);
      events = after.slice(0, SYNC_LIMIT);
      eventsTruncated = after.length > SYNC_LIMIT;
      cursorSeq = events.at(-1)?.seq ?? since;
      const fileIds = new Set(
        events
          .filter((e) => e.type.startsWith("file."))
          .map((e) => e.subject_id),
      );
      changed = [...fileIds].map((id) => this.toMetadata(this.files.get(id)!));
    }
    changed.sort((a, b) => b.updated_at.localeCompare(a.updated_at));

    const work = ws.events
      .filter(
        (e) =>
          e.type === "work.published" && e.seq > sinceSeq && e.seq <= cursorSeq,
      )
      .reverse()
      .map((e) => this.published.get(e.subject_id)!)
      .slice(0, SYNC_WORK_LIMIT + 1);
    const folders = [...this.folders.values()]
      .filter((f) => f.workspace_id === workspaceId)
      .map((f) => this.toFolderMetadata(f))
      .sort((a, b) => a.path.localeCompare(b.path));
    this.touch(actor, "last_synced_at");
    return {
      workspace: { id: workspaceId, name: ws.name },
      context: structuredClone(ws.context),
      context_version: ws.context_version,
      pending_proposals: this.proposalsIn(workspaceId)
        .filter((p) => p.status === "pending")
        .map(
          ({
            id,
            field,
            proposed_value,
            supersedes,
            rationale,
            proposed_by,
            created_at,
          }) => ({
            proposed_value: structuredClone(proposed_value),
            supersedes,
            status: "pending" as const,
            id,
            field,
            rationale,
            proposed_by,
            created_at,
          }),
        ),
      changed_files: changed.slice(0, SYNC_LIMIT),
      files_truncated: changed.length > SYNC_LIMIT,
      folders: folders.slice(0, SYNC_FOLDER_LIMIT),
      folders_truncated: folders.length > SYNC_FOLDER_LIMIT,
      recent_work: structuredClone(work.slice(0, SYNC_WORK_LIMIT)),
      work_truncated: work.length > SYNC_WORK_LIMIT,
      events: structuredClone(events),
      events_truncated: eventsTruncated,
      cursor: encodeCursor(workspaceId, cursorSeq),
    };
  }

  async proposeContextChange(
    actor: Actor,
    input: ProposeContextChangeInput,
  ): Promise<ContextProposal> {
    const workspaceId = this.resolveWorkspace(actor, input.workspace_id);
    const ws = this.workspaces.get(workspaceId)!;
    const operation = input.operation ?? "add";
    const working =
      input.field === "constraints" || input.field === "open_questions";
    if (!["add", "resolve", "remove"].includes(operation))
      throw new TandemError("INVALID_INPUT", "Invalid operation.");
    if (operation !== "add") {
      if (
        !input.entry_id ||
        !Number.isSafeInteger(input.expected_version) ||
        input.expected_version! < 0
      )
        throw new TandemError(
          "INVALID_INPUT",
          "entry_id and expected_version are required for resolve/remove.",
        );
      if (operation === "remove" && actor.actor_type !== "human")
        throw forbidden(workspaceId);
      if (
        !working ||
        (operation === "resolve" && input.field !== "open_questions")
      )
        throw new TandemError(
          "INVALID_INPUT",
          "Only open questions can be resolved; only working entries can be removed.",
        );
      if (input.expected_version !== ws.context_version)
        throw new TandemError(
          "VERSION_CONFLICT",
          "Sync and reconcile the latest context.",
          {
            current_version: ws.context_version,
            expected_version: input.expected_version,
          },
        );
    }
    if (
      input.supersedes &&
      (operation !== "add" ||
        input.field !== "decisions" ||
        !ws.context.decisions.some(
          (e) => e.id === input.supersedes && e.status === "active",
        ))
    )
      throw new TandemError(
        "INVALID_INPUT",
        "supersedes must name an active decision in this workspace.",
      );
    if (operation === "add" && input.entry_id !== undefined)
      throw new TandemError(
        "INVALID_INPUT",
        "entry_id is only valid for resolve/remove.",
      );
    if (
      input.expected_version !== undefined &&
      input.expected_version !== ws.context_version
    )
      throw new TandemError(
        "VERSION_CONFLICT",
        "Sync and reconcile the latest context.",
        {
          current_version: ws.context_version,
          expected_version: input.expected_version,
        },
      );
    const entries =
      input.field === "open_questions"
        ? ws.context.open_questions
        : ws.context.constraints;
    const target =
      operation !== "add"
        ? entries.find(
            (e) =>
              e.id === input.entry_id &&
              (operation === "remove" || e.status === "active"),
          )
        : undefined;
    if (operation !== "add" && !target)
      throw new TandemError("INVALID_INPUT", "Active context entry not found.");
    const proposedValue =
      operation === "add" ? input.proposed_value : target!.text;
    this.checkValue(workspaceId, input.field, proposedValue);
    const proposal: ContextProposal = {
      base_context_version: this.workspaces.get(workspaceId)!.context_version,
      id: `prop_${randomUUID()}`,
      workspace_id: workspaceId,
      field: input.field,
      proposed_value: structuredClone(proposedValue),
      rationale: input.rationale,
      source_ids: this.checkFileIds(workspaceId, input.source_ids),
      status: working ? "applied" : "pending",
      supersedes: input.supersedes ?? null,
      proposed_by: attribution(actor),
      created_at: new Date().toISOString(),
    };
    if (working) {
      if (operation === "add") {
        this.applyToContext(
          workspaceId,
          input.field,
          proposedValue,
          actor,
          proposal.source_ids,
        );
      } else {
        if (operation === "remove") entries.splice(entries.indexOf(target!), 1);
        else
          Object.assign(target!, {
            status: "resolved",
            resolved_by: attribution(actor),
            resolved_at: Date.now(),
          });
        ws.context_version += 1;
        ws.context.updated_at = new Date().toISOString();
        ws.context.updated_by = attribution(actor);
      }
    }
    this.proposals.set(proposal.id, proposal);
    this.appendEvent(
      workspaceId,
      working
        ? operation === "resolve"
          ? "context.resolved"
          : operation === "remove"
            ? "context.removed"
            : "context.recorded"
        : "context.proposed",
      proposal.id,
      proposal.proposed_by,
      `${proposal.field} change proposed`,
    );
    this.touch(actor, "last_action_at");
    return structuredClone(proposal);
  }

  async getApprovals(
    actor: Actor,
    input: GetApprovalsInput,
  ): Promise<ContextProposal[]> {
    const workspaceId = this.resolveWorkspace(actor, input.workspace_id);
    return structuredClone(
      this.proposalsIn(workspaceId)
        .filter((p) => input.status === "all" || p.status === input.status)
        .slice(0, input.limit),
    );
  }

  async publishWork(
    actor: Actor,
    input: PublishWorkInput,
  ): Promise<PublishedWork> {
    const workspaceId = this.resolveWorkspace(actor, input.workspace_id);
    const work: PublishedWork = {
      id: `pub_${randomUUID()}`,
      workspace_id: workspaceId,
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      file_ids: this.checkFileIds(workspaceId, input.file_ids),
      published_by: attribution(actor),
      created_at: new Date().toISOString(),
    };
    this.published.set(work.id, work);
    this.appendEvent(
      workspaceId,
      "work.published",
      work.id,
      work.published_by,
      `${work.kind} published: ${truncate(work.title, 80)}`,
    );
    this.touch(actor, "last_action_at");
    return structuredClone(work);
  }

  async decideProposal(
    actor: Actor,
    proposalId: string,
    decision: "approve" | "reject",
    note?: string,
  ): Promise<ContextProposal> {
    if (actor.actor_type !== "human") {
      throw new TandemError(
        "FORBIDDEN",
        "Only a human workspace owner or admin can approve or reject proposals, in the Tandem dashboard.",
        { proposal_id: proposalId },
      );
    }
    const proposal = this.proposals.get(proposalId);
    if (!proposal || !this.isMember(actor, proposal.workspace_id)) {
      throw new TandemError(
        "INVALID_INPUT",
        `No proposal with id ${proposalId}.`,
        {
          proposal_id: proposalId,
        },
      );
    }
    this.requireContextManager(actor, proposal.workspace_id);
    if (proposal.status !== "pending") {
      throw new TandemError(
        "INVALID_INPUT",
        `Proposal ${proposalId} was already ${proposal.status}.`,
        { proposal_id: proposalId, status: proposal.status },
      );
    }
    const now = new Date().toISOString();
    if (decision === "approve") {
      const currentVersion = this.workspaces.get(
        proposal.workspace_id,
      )!.context_version;
      if (proposal.base_context_version !== currentVersion) {
        throw new TandemError(
          "VERSION_CONFLICT",
          "The approved context changed since this proposal was created. Sync the workspace and propose a reconciled change for human approval.",
          {
            proposal_id: proposalId,
            base_context_version: proposal.base_context_version,
            context_version: currentVersion,
          },
        );
      }
      this.applyToContext(
        proposal.workspace_id,
        proposal.field,
        proposal.proposed_value,
        actor,
        proposal.source_ids,
        proposal.supersedes,
      );
    }
    proposal.status = decision === "approve" ? "approved" : "rejected";
    proposal.decided_by = { user_id: actor.user_id, actor_type: "human" };
    proposal.decided_at = now;
    if (note !== undefined) proposal.decision_note = note;
    this.appendEvent(
      proposal.workspace_id,
      decision === "approve" ? "context.approved" : "context.rejected",
      proposal.id,
      attribution(actor),
      `${proposal.field} change ${proposal.status}`,
    );
    return structuredClone(proposal);
  }

  async applyContextChange(
    actor: Actor,
    input: ApplyContextChangeInput,
  ): Promise<{ context: StructuredContext; context_version: number }> {
    if (actor.actor_type !== "human") throw approvalRequired(input.field);
    const workspaceId = this.resolveWorkspace(actor, input.workspace_id);
    this.requireContextManager(actor, workspaceId);
    this.applyToContext(workspaceId, input.field, input.value, actor, []);
    this.appendEvent(
      workspaceId,
      "context.approved",
      workspaceId,
      attribution(actor),
      `${input.field} changed by human`,
    );
    const ws = this.workspaces.get(workspaceId)!;
    return {
      context: structuredClone(ws.context),
      context_version: ws.context_version,
    };
  }

  private applyToContext(
    workspaceId: string,
    field: ContextField,
    value: ProposedValue,
    actor: Actor,
    sourceIds: string[],
    supersedes: string | null = null,
  ): void {
    // Re-checked at apply time: e.g. a proposed owner may have left since.
    this.checkValue(workspaceId, field, value);
    const ws = this.workspaces.get(workspaceId)!;
    const context = ws.context;
    const now = new Date().toISOString();
    const previous = supersedes
      ? context.decisions.find(
          (e) => e.id === supersedes && e.status === "active",
        )
      : undefined;
    if (supersedes && !previous)
      throw new TandemError(
        "INVALID_INPUT",
        "Superseded decision is no longer active.",
      );
    switch (field) {
      case "goal":
      case "scope":
        context[field] = value as string;
        break;
      case "constraints":
        context.constraints.push(
          contextEntry(
            (value as string).trim(),
            undefined,
            attribution(actor),
            sourceIds,
          ),
        );
        break;
      case "open_questions":
        context.open_questions.push({
          ...contextEntry(
            value as string,
            undefined,
            attribution(actor),
            sourceIds,
          ),
          created_at: now,
          created_by: attribution(actor),
        });
        break;
      case "decisions":
        context.decisions.push({
          ...contextEntry(
            value as string,
            undefined,
            attribution(actor),
            sourceIds,
          ),
          decided_at: now,
          source_ids: [...sourceIds],
        });
        if (previous) {
          previous.status = "superseded";
          previous.superseded_by = context.decisions.at(-1)!.id;
        }
        break;
      case "ownership": {
        const { area, owner_user_id } = value as Ownership;
        context.ownership = [
          ...context.ownership.filter((o) => nameKey(o.area) !== nameKey(area)),
          {
            ...contextEntry(area, undefined, attribution(actor), sourceIds),
            area,
            owner_user_id,
          },
        ];
        break;
      }
    }
    context.updated_at = now;
    context.updated_by = attribution(actor);
    ws.context_version += 1;
  }

  /** Throws INVALID_INPUT unless `value` has the shape `field` needs (see ProposedValue). */
  private checkValue(
    workspaceId: string,
    field: ContextField,
    value: ProposedValue | undefined,
  ): asserts value is ProposedValue {
    const fail = (expected: string) =>
      new TandemError(
        "INVALID_INPUT",
        `proposed_value for ${field} must be ${expected}.`,
        { field },
      );
    switch (field) {
      case "goal":
      case "scope":
        if (!isNonEmptyString(value))
          throw fail("the full new text, as a non-empty string");
        return;
      case "open_questions":
      case "decisions":
        if (!isNonEmptyString(value))
          throw fail("the decision text, as a non-empty string");
        return;
      case "constraints":
        if (!isNonEmptyString(value)) {
          throw fail(
            "one new constraint, as a non-empty string: approval appends it, and existing constraints can't be removed through a proposal",
          );
        }
        return;
      case "ownership":
        if (
          typeof value !== "object" ||
          value === null ||
          Array.isArray(value) ||
          !isNonEmptyString(value.area) ||
          !isNonEmptyString(value.owner_user_id)
        ) {
          throw fail(
            "an object { area, owner_user_id } with non-empty strings",
          );
        }
        if (
          !this.workspaces.get(workspaceId)!.members.has(value.owner_user_id)
        ) {
          throw new TandemError(
            "INVALID_INPUT",
            `owner_user_id ${value.owner_user_id} is not a member of this workspace.`,
            { field, owner_user_id: value.owner_user_id },
          );
        }
        return;
    }
  }

  /** Deduplicated ids; each must be a file in `workspaceId`, else FILE_NOT_FOUND. */
  private checkFileIds(workspaceId: string, ids: string[] = []): string[] {
    const unique = [...new Set(ids)];
    for (const id of unique) {
      if (this.files.get(id)?.workspace_id !== workspaceId) {
        throw fileNotFound(id);
      }
    }
    return unique;
  }

  /** Newest first. */
  private proposalsIn(workspaceId: string): ContextProposal[] {
    return [...this.proposals.values()]
      .filter((p) => p.workspace_id === workspaceId)
      .reverse();
  }

  private appendEvent(
    workspaceId: string,
    type: WorkspaceEventType,
    subjectId: string,
    actor: Attribution,
    summary: string,
  ): void {
    const events = this.workspaces.get(workspaceId)!.events;
    events.push({
      seq: events.length + 1,
      workspace_id: workspaceId,
      type,
      subject_id: subjectId,
      actor: { ...actor },
      at: new Date().toISOString(),
      summary,
    });
  }

  /** Presence is tracked for agent connections only. */
  private touch(actor: Actor, key: "last_synced_at" | "last_action_at"): void {
    if (actor.actor_type !== "agent") return;
    const k = connectionKey(actor);
    const connection = this.connections.get(k) ?? {
      client: actor.client,
      last_synced_at: null,
      last_action_at: null,
    };
    connection[key] = new Date().toISOString();
    this.connections.set(k, connection);
  }

  private requireContextManager(actor: Actor, workspaceId: string): void {
    const role = this.workspaces.get(workspaceId)?.members.get(actor.user_id);
    if (role !== "owner" && role !== "admin") {
      throw new TandemError(
        "FORBIDDEN",
        "Only a workspace owner or admin can change the approved context.",
        { workspace_id: workspaceId },
      );
    }
  }

  private resolveWorkspace(
    actor: Actor,
    workspaceId: string | undefined,
  ): string {
    if (workspaceId === undefined) {
      const first = [...this.workspaces].find(([, ws]) =>
        ws.members.has(actor.user_id),
      );
      if (!first) {
        throw new TandemError(
          "FORBIDDEN",
          "You are not a member of any workspace. Ask a teammate to invite you in the Tandem dashboard.",
        );
      }
      return first[0];
    }
    if (!this.isMember(actor, workspaceId)) throw forbidden(workspaceId);
    return workspaceId;
  }

  /**
   * The folder named by an id or a path argument (null for the root or when
   * both are omitted). `names` are the tool's argument names, for messages.
   */
  private folderArg(
    workspaceId: string,
    id: string | undefined,
    path: string | undefined,
    names: { id: string; path: string },
    missingHint = "Call list_files to browse the folders that exist.",
  ): StoredFolder | null {
    if (id !== undefined && path !== undefined) {
      throw new TandemError(
        "INVALID_INPUT",
        `Pass ${names.id} or ${names.path}, not both.`,
      );
    }
    if (id !== undefined) {
      // Another workspace's folder looks exactly like a missing one.
      const folder = this.folders.get(id);
      if (folder?.workspace_id !== workspaceId) throw folderNotFound(id);
      return folder;
    }
    if (path === undefined) return null;
    const found = this.resolvePath(workspaceId, path);
    if (!found) throw pathNotFound(path, missingHint);
    if (found.kind === "file") {
      throw pathNotFound(path, "That path is a file, not a folder.");
    }
    return found.kind === "folder" ? found.folder : null;
  }

  /** A move's destination: exactly one of to_folder_id and to_folder_path. */
  private destinationArg(
    workspaceId: string,
    input: { to_folder_id?: string; to_folder_path?: string },
  ): StoredFolder | null {
    if (
      input.to_folder_id === undefined &&
      input.to_folder_path === undefined
    ) {
      throw new TandemError(
        "INVALID_INPUT",
        'Pass to_folder_id or to_folder_path ("/" for the workspace root).',
      );
    }
    return this.folderArg(
      workspaceId,
      input.to_folder_id,
      input.to_folder_path,
      { id: "to_folder_id", path: "to_folder_path" },
      "Create it first with create_folder.",
    );
  }

  /** Resolves `path` segment by segment by nameKey; null if nothing is there. */
  private resolvePath(workspaceId: string, path: string): Resolved | null {
    let at: Resolved = { kind: "root" };
    for (const segment of parsePath(path)) {
      if (at.kind === "file") return null;
      const parentId = at.kind === "folder" ? at.folder.id : null;
      const child = this.childByKey(workspaceId, parentId, nameKey(segment));
      if (!child) return null;
      at = child;
    }
    return at;
  }

  /** The file or folder using `key` in a folder (one namespace per folder). */
  private childByKey(
    workspaceId: string,
    parentId: string | null,
    key: string,
    exceptId?: string,
  ): Exclude<Resolved, { kind: "root" }> | undefined {
    for (const folder of this.folders.values()) {
      if (
        folder.workspace_id === workspaceId &&
        folder.parent_id === parentId &&
        folder.id !== exceptId &&
        nameKey(folder.name) === key
      )
        return { kind: "folder", folder };
    }
    for (const file of this.files.values()) {
      if (
        file.workspace_id === workspaceId &&
        file.parent_id === parentId &&
        file.id !== exceptId &&
        nameKey(file.name) === key
      )
        return { kind: "file", file };
    }
    return undefined;
  }

  /** Throws NAME_EXISTS if another file or folder in the folder uses `name`. */
  private checkNameFree(
    workspaceId: string,
    parentId: string | null,
    name: string,
    selfId?: string,
  ): void {
    const taken = this.childByKey(workspaceId, parentId, nameKey(name), selfId);
    if (taken?.kind === "folder") {
      throw folderNameExists(taken.folder.id, taken.folder.name);
    }
    if (taken?.kind === "file") {
      throw nameExists(
        taken.file.id,
        taken.file.name,
        head(taken.file).version,
      );
    }
  }

  private insertFolder(
    actor: Actor,
    workspaceId: string,
    parentId: string | null,
    name: string,
  ): StoredFolder {
    const folder: StoredFolder = {
      id: `folder_${randomUUID()}`,
      workspace_id: workspaceId,
      parent_id: parentId,
      name,
      revision: 1,
      updated_at: new Date().toISOString(),
    };
    this.folders.set(folder.id, folder);
    this.appendEvent(
      workspaceId,
      "folder.created",
      folder.id,
      attribution(actor),
      `Created folder ${truncate(this.folderPath(folder.id), 120)}`,
    );
    return folder;
  }

  private getFolder(actor: Actor, folderId: string): StoredFolder {
    const folder = this.folders.get(folderId);
    if (!folder || !this.isMember(actor, folder.workspace_id))
      throw folderNotFound(folderId);
    return folder;
  }

  /** True if `folderId` is `ancestorId` or below it (everything is within the root, null). */
  private isWithin(
    folderId: string | null,
    ancestorId: string | null,
  ): boolean {
    if (ancestorId === null) return true;
    for (let at = folderId; at !== null; at = this.folders.get(at)!.parent_id) {
      if (at === ancestorId) return true;
    }
    return false;
  }

  /** Folders from the root down to and including `folderId`; 0 for the root. */
  private depthOf(folderId: string | null): number {
    let depth = 0;
    for (let at = folderId; at !== null; at = this.folders.get(at)!.parent_id) {
      depth++;
    }
    return depth;
  }

  /** Levels in the subtree rooted at `folder`, counting itself. */
  private heightOf(folder: StoredFolder): number {
    let below = 0;
    for (const child of this.folders.values()) {
      if (child.parent_id === folder.id) {
        below = Math.max(below, this.heightOf(child));
      }
    }
    return below + 1;
  }

  /** "/" for the root, otherwise "/a/b" with no trailing slash. */
  private folderPath(folderId: string | null): string {
    const names: string[] = [];
    for (let at = folderId; at !== null;) {
      const folder = this.folders.get(at)!;
      names.unshift(folder.name);
      at = folder.parent_id;
    }
    return `/${names.join("/")}`;
  }

  private toMetadata(file: StoredFile): FileMetadata {
    const latest = head(file);
    const parentPath = this.folderPath(file.parent_id);
    return {
      id: file.id,
      workspace_id: file.workspace_id,
      parent_id: file.parent_id,
      name: file.name,
      path: `${parentPath === "/" ? "" : parentPath}/${file.name}`,
      mime_type: file.mime_type,
      version: latest.version,
      updated_at: latest.created_at,
      updated_by: latest.created_by,
    };
  }

  private toFolderMetadata(folder: StoredFolder): FolderMetadata {
    return {
      id: folder.id,
      parent_id: folder.parent_id,
      name: folder.name,
      path: this.folderPath(folder.id),
      revision: folder.revision,
      updated_at: folder.updated_at,
    };
  }

  private getFile(actor: Actor, fileId: string): StoredFile {
    // Another tenant's file looks exactly like a missing one, so ids can't be probed.
    const file = this.files.get(fileId);
    if (!file || !this.isMember(actor, file.workspace_id))
      throw fileNotFound(fileId);
    return file;
  }

  private isMember(actor: Actor, workspaceId: string): boolean {
    return (
      this.workspaces.get(workspaceId)?.members.has(actor.user_id) ?? false
    );
  }
}

const SNIPPET_CHARS = 160;

/** ~SNIPPET_CHARS of `content` centred on [at, at+length), whitespace collapsed. */
function snippet(content: string, at: number, length: number): string {
  const lead = Math.max(0, Math.floor((SNIPPET_CHARS - length) / 2));
  const start = Math.max(
    0,
    Math.min(at - lead, content.length - SNIPPET_CHARS),
  );
  const end = start + SNIPPET_CHARS;
  const text = content.slice(start, end).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + text + (end < content.length ? "…" : "");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Mock users have no profile: "user_alex" is shown as "Alex". */
function mockName(userId: string): string {
  const base = userId.replace(/^user_/, "");
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function connectionKey(actor: Actor): string {
  return JSON.stringify([actor.user_id, actor.client]);
}

/** Mock connections are keyed by person and client (see connectionKey). */
function attribution(actor: Actor): Attribution {
  return {
    actor_type: actor.actor_type,
    user_id: actor.user_id,
    client: actor.client,
    ...(actor.actor_type === "agent"
      ? {
          agent_connection_id: `conn_${actor.user_id}_${actor.client}`,
          label: `${actor.user_id}'s ${actor.client} assistant`,
        }
      : {}),
  };
}

function head(file: StoredFile): Revision {
  return file.revisions[file.revisions.length - 1]!;
}

function newRevision(actor: Actor, version: number, content: string): Revision {
  return {
    version,
    content,
    created_at: new Date().toISOString(),
    created_by: attribution(actor),
  };
}

/**
 * Checks `expected` against the file's head version and returns it. Fail
 * closed: anything other than an exact match is rejected without writing.
 */
function checkVersion(
  file: StoredFile,
  expected: number,
  tool: "update_document" | "move_file",
): number {
  const current = head(file).version;
  if (!Number.isSafeInteger(expected) || expected < 1) {
    throw new TandemError(
      "INVALID_INPUT",
      "expected_version must be a positive integer: the file.version returned by read_file.",
      { file_id: file.id, expected_version: expected },
    );
  }
  if (expected !== current) {
    throw expected > current
      ? versionAhead(file.id, current, expected)
      : versionConflict(file.id, current, expected, tool);
  }
  return current;
}

/**
 * Segments of a path (docs/filesystem.md): the leading "/" is optional and one
 * trailing "/" is ignored, so "/" is the root ([]). Empty, "." and ".."
 * segments throw INVALID_PATH.
 */
function parsePath(path: string): string[] {
  if (path === "") throw invalidPath(path, "it is empty");
  const body = path.startsWith("/") ? path.slice(1) : path;
  if (body === "") return [];
  const segments = (body.endsWith("/") ? body.slice(0, -1) : body).split("/");
  for (const segment of segments) {
    if (!nameKey(segment)) throw invalidPath(path, "it has an empty segment");
    const trimmed = segment.trim();
    if (trimmed === "." || trimmed === "..") {
      throw invalidPath(path, `"." and ".." segments aren't supported`);
    }
  }
  return segments;
}

/** The stored form of a new file or folder name, or INVALID_INPUT. */
function validName(raw: string): string {
  const name = storedName(raw);
  if (isValidName(name)) return name;
  if (!nameKey(name) || name.length > MAX_NAME_LENGTH) {
    throw new TandemError(
      "INVALID_INPUT",
      "name must contain 1–255 visible characters.",
      { name: raw },
    );
  }
  if (name.includes("/")) {
    throw new TandemError(
      "INVALID_INPUT",
      'A name can\'t contain "/". To put a file in a folder, pass folder_path (create the folder first with create_folder).',
      { name: raw },
    );
  }
  throw new TandemError("INVALID_INPUT", 'A name can\'t be "." or "..".', {
    name: raw,
  });
}
