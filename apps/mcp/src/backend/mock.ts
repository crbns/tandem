import { randomUUID } from "node:crypto";
import {
  TandemError,
  approvalRequired,
  fileNotFound,
  forbidden,
  nameExists,
  versionAhead,
  versionConflict,
} from "../errors.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { nameKey, storedName } from "../names.js";
import type {
  Actor,
  AgentConnection,
  ApplyContextChangeInput,
  Attribution,
  ContextField,
  ContextProposal,
  CreateDocumentInput,
  FileMetadata,
  FileVersions,
  FileWithContent,
  GetApprovalsInput,
  ListFilesInput,
  Ownership,
  ProposeContextChangeInput,
  ProposedValue,
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
  WorkspaceRole,
  WorkspaceSummary,
} from "./types.js";

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

const SEED_BRIEF = `# Project brief

Goal: ship the Tandem demo for Cal Hacks.
`;

/** Max files and events per sync_workspace call. */
const SYNC_LIMIT = 50;

/** In-memory backend for local development and tests. State is lost on restart. */
export class MockBackend implements TandemBackend {
  readonly kind = "mock";
  // Insertion order matters: an actor's first workspace is their default.
  private readonly workspaces = new Map<string, StoredWorkspace>();
  private readonly files = new Map<string, StoredFile>();
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
          "Submissions are due Oct 25, 9 AM PT.",
          "Every write carries expected_version; stale writes fail with VERSION_CONFLICT.",
        ],
        decisions: [
          {
            id: "dec_convex",
            text: "Use Convex for the database, auth, and file storage.",
            status: "approved",
            decided_at: now,
            source_ids: ["file_brief"],
          },
        ],
        ownership: [{ area: "MCP server", owner_user_id: "user_alex" }],
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
        constraints: ["Total budget under $2,000."],
        decisions: [],
        ownership: [{ area: "Venue", owner_user_id: "user_jordan" }],
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
  ): Promise<FileMetadata[]> {
    const workspaceId = this.resolveWorkspace(actor, input.workspace_id);
    // No folders in the mock yet, so no folder_id can name a valid folder.
    if (input.folder_id !== undefined) {
      throw new TandemError(
        "INVALID_INPUT",
        "Folders are not supported yet; omit folder_id.",
        { folder_id: input.folder_id },
      );
    }
    const query = input.query?.toLowerCase();
    return [...this.files.values()]
      .filter((f) => f.workspace_id === workspaceId)
      .filter(
        (f) => query === undefined || f.name.toLowerCase().includes(query),
      )
      .map(toMetadata);
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
        file: toMetadata(f),
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

  async readFile(actor: Actor, fileId: string): Promise<FileWithContent> {
    const file = this.getFile(actor, fileId);
    return { file: toMetadata(file), content: head(file).content };
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
    return { file: toMetadata(file), versions };
  }

  async createDocument(
    actor: Actor,
    input: CreateDocumentInput,
  ): Promise<FileMetadata> {
    const workspaceId = this.resolveWorkspace(actor, input.workspace_id);
    // No folders in the mock yet, so no parent_id can name a valid folder.
    if (input.parent_id !== undefined) {
      throw new TandemError(
        "INVALID_INPUT",
        "Folders are not supported yet; omit parent_id.",
        { parent_id: input.parent_id },
      );
    }
    const name = storedName(input.name);
    const key = nameKey(name);
    if (!key || name.length > 255) {
      throw new TandemError(
        "INVALID_INPUT",
        "name must contain 1–255 visible characters.",
        { name: input.name },
      );
    }
    // No await between the check and the insert, so this is atomic in Node.
    const existing = [...this.files.values()].find(
      (f) =>
        f.workspace_id === workspaceId &&
        f.parent_id === null &&
        nameKey(f.name) === key,
    );
    if (existing) {
      throw nameExists(existing.id, existing.name, head(existing).version);
    }
    const file: StoredFile = {
      id: `file_${randomUUID()}`,
      workspace_id: workspaceId,
      parent_id: null,
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
    return toMetadata(file);
  }

  async updateDocument(
    actor: Actor,
    input: UpdateDocumentInput,
  ): Promise<FileMetadata> {
    const file = this.getFile(actor, input.file_id);
    const current = head(file).version;
    const expected = input.expected_version;
    if (!Number.isSafeInteger(expected) || expected < 1) {
      throw new TandemError(
        "INVALID_INPUT",
        "expected_version must be a positive integer: the file.version returned by read_file.",
        { file_id: file.id, expected_version: expected },
      );
    }
    // Fail closed: anything other than an exact match is rejected.
    if (expected !== current) {
      throw expected > current
        ? versionAhead(file.id, current, expected)
        : versionConflict(file.id, current, expected);
    }
    file.revisions.push(newRevision(actor, current + 1, input.content));
    this.appendEvent(
      file.workspace_id,
      "file.updated",
      file.id,
      attribution(actor),
      `${truncate(file.name, 80)} updated to v${current + 1}`,
    );
    this.touch(actor, "last_action_at");
    return toMetadata(file);
  }

  async syncWorkspace(actor: Actor, input: SyncInput): Promise<SyncResult> {
    const workspaceId = this.resolveWorkspace(actor, input.workspace_id);
    const ws = this.workspaces.get(workspaceId)!;
    const headSeq = ws.events.length;

    let changed: FileMetadata[];
    let events: WorkspaceEvent[];
    let eventsTruncated: boolean;
    let cursorSeq: number;
    if (input.since === undefined) {
      changed = [...this.files.values()]
        .filter((f) => f.workspace_id === workspaceId)
        .map(toMetadata);
      events = ws.events.slice(-SYNC_LIMIT);
      eventsTruncated = ws.events.length > SYNC_LIMIT;
      cursorSeq = headSeq;
    } else {
      const since = decodeCursor(input.since, workspaceId, headSeq);
      const after = ws.events.filter((e) => e.seq > since);
      events = after.slice(0, SYNC_LIMIT);
      eventsTruncated = after.length > SYNC_LIMIT;
      cursorSeq = events.at(-1)?.seq ?? since;
      const fileIds = new Set(
        events
          .filter((e) => e.type.startsWith("file."))
          .map((e) => e.subject_id),
      );
      changed = [...fileIds].map((id) => toMetadata(this.files.get(id)!));
    }
    changed.sort((a, b) => b.updated_at.localeCompare(a.updated_at));

    this.touch(actor, "last_synced_at");
    return {
      workspace: { id: workspaceId, name: ws.name },
      context: structuredClone(ws.context),
      context_version: ws.context_version,
      pending_proposals: this.proposalsIn(workspaceId)
        .filter((p) => p.status === "pending")
        .map(({ id, field, rationale, proposed_by, created_at }) => ({
          id,
          field,
          rationale,
          proposed_by,
          created_at,
        })),
      changed_files: changed.slice(0, SYNC_LIMIT),
      files_truncated: changed.length > SYNC_LIMIT,
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
    this.checkValue(workspaceId, input.field, input.proposed_value);
    const proposal: ContextProposal = {
      id: `prop_${randomUUID()}`,
      workspace_id: workspaceId,
      field: input.field,
      proposed_value: structuredClone(input.proposed_value),
      rationale: input.rationale,
      source_ids: this.checkFileIds(workspaceId, input.source_ids),
      status: "pending",
      proposed_by: attribution(actor),
      created_at: new Date().toISOString(),
    };
    this.proposals.set(proposal.id, proposal);
    this.appendEvent(
      workspaceId,
      "context.proposed",
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
      this.applyToContext(
        proposal.workspace_id,
        proposal.field,
        proposal.proposed_value,
        actor,
        proposal.source_ids,
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
  ): void {
    // Re-checked at apply time: e.g. a proposed owner may have left since.
    this.checkValue(workspaceId, field, value);
    const ws = this.workspaces.get(workspaceId)!;
    const context = ws.context;
    const now = new Date().toISOString();
    switch (field) {
      case "goal":
      case "scope":
        context[field] = value as string;
        break;
      case "constraints":
        context.constraints = [...(value as string[])];
        break;
      case "decisions":
        context.decisions.push({
          id: `dec_${randomUUID()}`,
          text: value as string,
          status: "approved",
          decided_at: now,
          source_ids: [...sourceIds],
        });
        break;
      case "ownership": {
        const { area, owner_user_id } = value as Ownership;
        context.ownership = [
          ...context.ownership.filter((o) => nameKey(o.area) !== nameKey(area)),
          { area, owner_user_id },
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
    value: ProposedValue,
  ): void {
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
      case "decisions":
        if (!isNonEmptyString(value))
          throw fail("the decision text, as a non-empty string");
        return;
      case "constraints":
        if (!Array.isArray(value) || !value.every(isNonEmptyString)) {
          throw fail(
            "the full new list of constraints, as an array of non-empty strings",
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

function connectionKey(actor: Actor): string {
  return JSON.stringify([actor.user_id, actor.client]);
}

function attribution(actor: Actor): Attribution {
  return {
    actor_type: actor.actor_type,
    user_id: actor.user_id,
    client: actor.client,
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

function toMetadata(file: StoredFile): FileMetadata {
  const latest = head(file);
  return {
    id: file.id,
    workspace_id: file.workspace_id,
    parent_id: file.parent_id,
    name: file.name,
    mime_type: file.mime_type,
    version: latest.version,
    updated_at: latest.created_at,
    updated_by: latest.created_by,
  };
}
