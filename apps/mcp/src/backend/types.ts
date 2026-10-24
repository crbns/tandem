/** Who is making a request. Always comes from the verified API key, never from tool arguments. */
export interface Actor {
  user_id: string;
  /** The agent client the token was issued to (e.g. an OAuth client id), or "dashboard" for humans. */
  client: string;
  /**
   * Every MCP request is "agent"; the auth layer sets it, never tool arguments.
   * "human" is only for signed-in dashboard calls (and tests).
   */
  actor_type: "agent" | "human";
  /**
   * The caller's bearer token, for backends where the backend itself is the
   * authority (Convex verifies it on every call). Never echo or log it.
   */
  credential?: string;
}

export interface Attribution {
  /** "agent" for writes made through MCP, "human" for edits made in the dashboard. */
  actor_type: "agent" | "human";
  user_id: string;
  /** The agent client, or "dashboard" for human edits. */
  client: string;
  /**
   * The agent connection that made the change (agent writes only). One person
   * can have several connections for the same client, e.g. laptop and work.
   */
  agent_connection_id?: string;
  /** Display label: the connection's name for agents, the person's name for humans. */
  label?: string;
}

export type WorkspaceRole = "owner" | "admin" | "member";

export interface WorkspaceSummary {
  id: string;
  name: string;
  /** The actor's role in this workspace. */
  role: WorkspaceRole;
  member_count: number;
  /** True for the workspace used when a call omits `workspace_id`. At most one per actor (none if they belong to no workspace). */
  is_default: boolean;
}

export interface FileMetadata {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  name: string;
  mime_type: string;
  version: number;
  updated_at: string;
  updated_by: Attribution;
}

export interface FileWithContent {
  file: FileMetadata;
  content: string;
}

export interface ListFilesInput {
  workspace_id?: string;
  /** Folders aren't supported yet: throw INVALID_INPUT for any folder_id. */
  folder_id?: string;
  query?: string;
}

export interface CreateDocumentInput {
  /**
   * Stored as `storedName` (src/names.ts): Unicode NFC, zero-width characters
   * removed, trimmed. Unique per workspace and parent, compared by `nameKey`
   * (src/names.ts): Unicode NFKC, strip zero-width characters (U+200B-U+200D,
   * U+2060, U+FEFF), trim, collapse internal whitespace to one space, case-fold
   * with uppercase then lowercase (so "Straße" and "STRASSE" collide).
   * If the key is empty, throw INVALID_INPUT. If a file with the same key exists
   * there, throw NAME_EXISTS with its file_id, name, and current_version.
   * 1–255 characters; reject longer names with INVALID_INPUT.
   */
  name: string;
  content: string;
  mime_type: string;
  workspace_id?: string;
  /**
   * Must name an existing folder in the same workspace as the new document;
   * otherwise throw INVALID_INPUT. Never link a record across workspaces.
   */
  parent_id?: string;
}

export interface UpdateDocumentInput {
  file_id: string;
  content: string;
  expected_version: number;
}

export interface SearchFilesInput {
  /** Case-insensitive substring matched against file names and current-revision content. */
  query: string;
  workspace_id?: string;
  /** 1–50. */
  limit: number;
}

export interface SearchResult {
  file: FileMetadata;
  /**
   * About 160 chars of current content around the first content match (or the
   * first 160 chars for a name-only match), whitespace collapsed to single spaces.
   */
  snippet: string;
  /** "name" whenever the name matches, even if the content matches too. */
  match: "name" | "content";
}

export interface FileVersion {
  version: number;
  created_at: string;
  author: Attribution;
  /** UTF-8 byte length of that revision's content. */
  size_bytes: number;
}

export interface FileVersions {
  file: FileMetadata;
  /** Newest first. */
  versions: FileVersion[];
}

/** Stable context identity and retained lifecycle history. */
export interface ContextEntry {
  source_ids: string[];
  updated_at: string;
  updated_by: Attribution;
  id: string;
  text: string;
  status: "active" | "resolved" | "superseded";
  resolved_by: Attribution | null;
  resolved_at: number | null;
  superseded_by: string | null;
}

export interface Decision extends ContextEntry {
  decided_at: string;
  source_ids: string[];
}

export interface Ownership {
  area: string;
  owner_user_id: string;
}

export interface OpenQuestion extends ContextEntry {
  created_at: string;
  created_by: Attribution;
}

/** Current context and retained resolved/superseded entries. */
export interface StructuredContext {
  goal: string;
  scope: string;
  constraints: ContextEntry[];
  decisions: Decision[];
  ownership: (Ownership & ContextEntry)[];
  open_questions: OpenQuestion[];
  updated_at: string;
  updated_by: Attribution;
}

export type ContextField =
  | "goal"
  | "scope"
  | "constraints"
  | "decisions"
  | "ownership"
  | "open_questions";

/** Text for context fields, or a structured owner for ownership. */
export type ProposedValue = string | Ownership;
export type ContextOperation = "add" | "resolve" | "remove";
export type ProposalStatus = "pending" | "applied" | "approved" | "rejected";
export type ProposalField = ContextField;

export interface ContextProposal {
  /** Context version this proposal was based on; stale proposals cannot be approved. */
  base_context_version: number;
  id: string;
  workspace_id: string;
  field: ProposalField;
  supersedes: string | null;
  proposed_value: ProposedValue;
  rationale: string;
  source_ids: string[];
  status: ProposalStatus | "stale";
  proposed_by: Attribution;
  created_at: string;
  /** Set once a human owner or admin decides; agents can never decide. */
  decided_by?: { user_id: string; actor_type: "human" };
  decided_at?: string;
  decision_note?: string;
}

/** Pending changes stay explicitly proposed and retain replacement links. */
export type ProposalSummary = Pick<
  ContextProposal,
  | "id"
  | "field"
  | "proposed_value"
  | "supersedes"
  | "rationale"
  | "proposed_by"
  | "created_at"
> & { status: "pending" };

export interface PublishedWork {
  id: string;
  workspace_id: string;
  kind: "deliverable" | "finding";
  title: string;
  summary: string;
  file_ids: string[];
  published_by: Attribution;
  created_at: string;
}

export type WorkspaceEventType =
  | "file.created"
  | "file.updated"
  | "context.migrated"
  | "context.recorded"
  | "context.resolved"
  | "context.removed"
  | "context.proposed"
  | "context.approved"
  | "context.rejected"
  | "work.published"
  // Recorded by the Convex backend only:
  | "context.stale"
  | "workspace.created"
  | "workspace.member_added"
  | "workspace.invite_created"
  | "workspace.invite_revoked"
  | "folder.created"
  | "agent.connected"
  | "agent.revoked";

/**
 * Appended in the same commit as the change it records. `seq` is monotonic per
 * workspace. `summary` is short metadata (e.g. "brief.md updated to v3"),
 * never document content or proposed values.
 */
export interface WorkspaceEvent {
  seq: number;
  workspace_id: string;
  type: WorkspaceEventType;
  /** The file, proposal, or published work the event is about (the workspace for a direct human change). */
  subject_id: string;
  actor: Attribution;
  at: string;
  summary: string;
}

/**
 * A current member of the actor's default workspace, for naming an owner in
 * an ownership proposal. Never includes email addresses.
 */
export interface WorkspaceMember {
  user_id: string;
  /** Display name; "Workspace member" when the person has none. */
  name: string;
  role: WorkspaceRole;
}

/**
 * Presence for one (user, client) pair. Honest timestamps, never "online":
 * a native chat can't be reached by Tandem between tool calls. Presence is per
 * (user, client) across all workspaces, not per workspace.
 */
export interface AgentConnection {
  client: string;
  /** Last successful sync_workspace, or null. */
  last_synced_at: string | null;
  /** Last successful write (create, update, propose, publish), or null. */
  last_action_at: string | null;
}

export interface SyncInput {
  workspace_id?: string;
  /** Opaque cursor from a previous sync of the same workspace. */
  since?: string;
}

export interface SyncResult {
  workspace: { id: string; name: string };
  context: StructuredContext;
  context_version: number;
  /** Newest first. */
  pending_proposals: ProposalSummary[];
  /** Newest updated_at first, at most 50. */
  changed_files: FileMetadata[];
  files_truncated: boolean;
  /** Newest first, at most 20; with since, restricted to this event page. */
  recent_work: PublishedWork[];
  /** Older matching work was omitted; this is not a work pagination cursor. */
  work_truncated: boolean;
  /** Oldest first, at most 50. */
  events: WorkspaceEvent[];
  /**
   * With `since`: more events remain, so sync again with the returned cursor.
   * Without `since` (snapshot): only the latest 50 events are shown; older ones
   * were omitted and there is nothing to page (the cursor is already at head).
   */
  events_truncated: boolean;
  cursor: string;
}

export interface ProposeContextChangeInput {
  operation?: ContextOperation;
  entry_id?: string;
  supersedes?: string;
  expected_version?: number;
  field: ContextField;
  proposed_value: ProposedValue;
  rationale: string;
  /** Each must be a file in the same workspace, else FILE_NOT_FOUND. */
  source_ids?: string[];
  workspace_id?: string;
}

export interface GetApprovalsInput {
  workspace_id?: string;
  status: ProposalStatus | "stale" | "all";
  /** 1–50. */
  limit: number;
}

export interface PublishWorkInput {
  kind: PublishedWork["kind"];
  title: string;
  summary: string;
  /** Each must be a file in the same workspace, else FILE_NOT_FOUND. */
  file_ids?: string[];
  workspace_id?: string;
}

export interface ApplyContextChangeInput {
  field: ContextField;
  value: ProposedValue;
  workspace_id?: string;
}

/**
 * Storage operations the MCP tools need. Implementations must enforce workspace
 * membership on every call and throw TandemError for expected failures.
 * When `workspace_id` is omitted, use the actor's default workspace.
 *
 * Every successful write (createDocument, updateDocument, proposeContextChange,
 * publishWork, decideProposal, applyContextChange) appends a WorkspaceEvent
 * atomically with the change. For agent actors, writes through the MCP tools
 * also set the connection's last_action_at.
 */
export interface TandemBackend {
  /** Which implementation this is, e.g. "mock". Dev-only features check it. */
  readonly kind: string;
  /** Only workspaces the actor is a member of. Returns [] (not FORBIDDEN) if there are none. */
  listWorkspaces(actor: Actor): Promise<WorkspaceSummary[]>;
  /**
   * Members of the actor's default workspace only (at most 100; `truncated`
   * when there are more). Empty if the actor has no workspace.
   */
  listMembers(
    actor: Actor,
  ): Promise<{ members: WorkspaceMember[]; truncated: boolean }>;
  /** The actor's own (user, client) presence; nulls if it never synced or wrote. */
  getConnection(actor: Actor): Promise<AgentConnection>;
  /**
   * Approved context, pending proposal summaries, changed files and events.
   * Without `since`: all files (newest first, capped at 50) and the latest 50
   * events, with the cursor at the newest event. With `since`: events after the
   * cursor (oldest first, at most 50), the files those events touched, and the
   * cursor at the last returned event, so a truncated sync can be continued.
   * A malformed cursor, one for another workspace, or one ahead of the newest
   * event throws invalidCursor() (INVALID_INPUT). Records last_synced_at.
   */
  syncWorkspace(actor: Actor, input: SyncInput): Promise<SyncResult>;
  /**
   * Authoritative additions await approval; working additions and question
   * resolution apply immediately. Only humans may remove working entries.
   */
  proposeContextChange(
    actor: Actor,
    input: ProposeContextChangeInput,
  ): Promise<ContextProposal>;
  /** Proposals in one workspace, newest first, at most `limit`. */
  getApprovals(
    actor: Actor,
    input: GetApprovalsInput,
  ): Promise<ContextProposal[]>;
  /**
   * Records authorized project work and a work.published event. It doesn't
   * change files or context.
   */
  publishWork(actor: Actor, input: PublishWorkInput): Promise<PublishedWork>;
  /**
   * Human decision on a proposal; not exposed over MCP. Agents get FORBIDDEN;
   * an unknown or other-tenant proposal gets INVALID_INPUT; a member without owner/admin role gets
   * FORBIDDEN; an already decided proposal gets INVALID_INPUT. Approving applies
   * proposed_value (context_version + 1), or throws VERSION_CONFLICT with the
   * current context_version if base_context_version is stale. Rejection is
   * allowed even when stale. Either way it sets decided_by and
   * decided_at and appends context.approved or context.rejected.
   */
  decideProposal(
    actor: Actor,
    proposalId: string,
    decision: "approve" | "reject",
    note?: string,
  ): Promise<ContextProposal>;
  /**
   * Direct context change; not exposed over MCP. Agents ALWAYS get
   * APPROVAL_REQUIRED (they must use proposeContextChange). Human owners and admins apply
   * the value like an approved proposal; human members get FORBIDDEN.
   */
  applyContextChange(
    actor: Actor,
    input: ApplyContextChangeInput,
  ): Promise<{ context: StructuredContext; context_version: number }>;
  listFiles(actor: Actor, input: ListFilesInput): Promise<FileMetadata[]>;
  /**
   * Searches one workspace, with the same membership check as listFiles (FORBIDDEN
   * for a non-member workspace_id). Name matches come first, then newest
   * updated_at first; at most `limit` results.
   */
  searchFiles(actor: Actor, input: SearchFilesInput): Promise<SearchResult[]>;
  readFile(actor: Actor, fileId: string): Promise<FileWithContent>;
  /**
   * Revision metadata (no content), newest first, at most `limit` (1–100).
   * Unknown and cross-tenant files both throw FILE_NOT_FOUND, like readFile.
   */
  getFileVersions(
    actor: Actor,
    fileId: string,
    limit: number,
  ): Promise<FileVersions>;
  /**
   * The name check and the insert must happen atomically, in one transaction.
   * In Convex that means one mutation, shared by the dashboard and MCP, that
   * looks up a stored normalized `name_key` through an index on
   * (workspace_id, parent_id, name_key) and inserts in the same mutation;
   * Convex has no unique indexes, so OCC on that index read is what prevents
   * duplicates. Renames and moves must run the same check.
   */
  createDocument(
    actor: Actor,
    input: CreateDocumentInput,
  ): Promise<FileMetadata>;
  /**
   * Atomically writes version N+1 only if `expected_version` equals the current version N.
   * Throws INVALID_INPUT when `expected_version` is not a safe integer >= 1 (this
   * layer can't rely on the MCP schema: the dashboard calls it directly), then
   * VERSION_CONFLICT when it is lower than N and INVALID_INPUT when it is higher.
   * Any value that isn't exactly N must fail; never write on a failed comparison.
   */
  updateDocument(
    actor: Actor,
    input: UpdateDocumentInput,
  ): Promise<FileMetadata>;
}
