/** Who is making a request. Always comes from the verified API key, never from tool arguments. */
export interface Actor {
  user_id: string;
  /** The agent client the token was issued to (e.g. an OAuth client id). */
  client: string;
}

export interface Attribution {
  actor_type: "agent";
  user_id: string;
  client: string;
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
   * Stored trimmed. Unique per workspace and parent, compared by `nameKey`
   * (src/names.ts): Unicode NFKC, strip zero-width characters (U+200B-U+200D,
   * U+2060, U+FEFF), trim, collapse internal whitespace to one space, lowercase.
   * If the key is empty, throw INVALID_INPUT. If a file with the same key exists
   * there, throw NAME_EXISTS with its file_id, name, and current_version.
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

/**
 * Storage operations the MCP tools need. Implementations must enforce workspace
 * membership on every call and throw TandemError for expected failures.
 * When `workspace_id` is omitted, use the actor's default workspace.
 */
export interface TandemBackend {
  /** Which implementation this is, e.g. "mock". Dev-only features check it. */
  readonly kind: string;
  listFiles(actor: Actor, input: ListFilesInput): Promise<FileMetadata[]>;
  readFile(actor: Actor, fileId: string): Promise<FileWithContent>;
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
