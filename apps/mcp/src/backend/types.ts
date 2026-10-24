/** Who is making a request. Always comes from the verified API key, never from tool arguments. */
export interface Actor {
  user_id: string;
  /** The agent client the token was issued to (e.g. an OAuth client id). */
  client: string;
}

export interface Attribution {
  /** "agent" for writes made through MCP, "human" for edits made in the dashboard. */
  actor_type: "agent" | "human";
  user_id: string;
  /** The agent client, or "dashboard" for human edits. */
  client: string;
}

export type WorkspaceRole = "owner" | "member";

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
   * Unique per workspace and parent, compared trimmed and case-insensitively.
   * If a file with the same name exists there, throw NAME_EXISTS with its
   * file_id, name, and current version.
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

/**
 * Storage operations the MCP tools need. Implementations must enforce workspace
 * membership on every call and throw TandemError for expected failures.
 * When `workspace_id` is omitted, use the actor's default workspace.
 */
export interface TandemBackend {
  /** Only workspaces the actor is a member of. Returns [] (not FORBIDDEN) if there are none. */
  listWorkspaces(actor: Actor): Promise<WorkspaceSummary[]>;
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
  createDocument(
    actor: Actor,
    input: CreateDocumentInput,
  ): Promise<FileMetadata>;
  /**
   * Atomically writes version N+1 only if `expected_version` equals the current version N.
   * Throws VERSION_CONFLICT when it is lower than N, and INVALID_INPUT when it is higher.
   */
  updateDocument(
    actor: Actor,
    input: UpdateDocumentInput,
  ): Promise<FileMetadata>;
}
