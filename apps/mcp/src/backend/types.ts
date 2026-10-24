/** Who is making a request. Always comes from the verified bearer token, never from tool arguments. */
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
  folder_id?: string;
  query?: string;
}

export interface CreateDocumentInput {
  name: string;
  content: string;
  mime_type: string;
  workspace_id?: string;
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
  listFiles(actor: Actor, input: ListFilesInput): Promise<FileMetadata[]>;
  readFile(actor: Actor, fileId: string): Promise<FileWithContent>;
  createDocument(
    actor: Actor,
    input: CreateDocumentInput,
  ): Promise<FileMetadata>;
  /** Atomically writes version N+1 only if `expected_version` equals the current version N. */
  updateDocument(
    actor: Actor,
    input: UpdateDocumentInput,
  ): Promise<FileMetadata>;
}
