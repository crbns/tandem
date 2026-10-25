import type {
  ContextChangeInput,
  ContextProposalInput,
  ContextDetails,
  PublishedWorkPage,
  Task,
  WorkspaceMember,
  AgentActivity,
  AgentClient,
  AgentConnection,
  ConsentRequest,
  ContextApproval,
  ContextProposal,
  ConflictList,
  DecideProposalOptions,
  NewAgentConnection,
  ProposalStatus,
  CreateFileInput,
  DirectoryListing,
  FileDetail,
  FolderSummary,
  FileSummary,
  FileUpdate,
  ProjectContext,
  Revision,
  Workspace,
  InviteRole,
  WorkspaceInvite,
  UploadTarget,
  AgentNetwork,
  Subscriber,
  TimelinePage,
  TimelineQuery,
} from "./types";

/**
 * Everything the dashboard needs from the backend. Implemented by the Convex
 * adapter (real mode) and the in-memory mock. Every method rejects with a
 * `TandemApiError`; business rules (permissions, optimistic locking, revision
 * inserts) live in the backend, never here.
 */
export interface TandemApi {
  listWorkspaces(): Promise<Workspace[]>;
  createWorkspace(name: string): Promise<string>;
  createInvite(workspaceId: string, role: InviteRole): Promise<{ inviteId: string; token: string; expiresAt: number }>;
  acceptInvite(token: string): Promise<{ workspaceId: string }>;
  listInvites(workspaceId: string): Promise<WorkspaceInvite[]>;
  revokeInvite(inviteId: string): Promise<void>;
  listFiles(workspaceId: string): Promise<FileSummary[]>;
  createFile(
    workspaceId: string,
    input: CreateFileInput,
  ): Promise<{ id: string; version: number }>;
  renameFile(fileId: string, name: string, expectedVersion: number): Promise<{ version: number }>;
  deleteFile(fileId: string, expectedVersion: number): Promise<void>;
  /** A new head version (N+1) in another folder; `parentId` null is the root. */
  moveFile(fileId: string, parentId: string | null, expectedVersion: number): Promise<{ version: number }>;
  /**
   * A folder's immediate children (folders, then files). `folderId` omitted is
   * the workspace root; rejects with FOLDER_NOT_FOUND for a deleted folder.
   */
  listDirectory(workspaceId: string, folderId?: string | null): Promise<DirectoryListing>;
  /** Every live folder in the workspace, for pickers and breadcrumbs. */
  listFolderTree(workspaceId: string): Promise<FolderSummary[]>;
  createFolder(workspaceId: string, input: { name: string; parentId?: string | null }): Promise<FolderSummary>;
  renameFolder(folderId: string, name: string, expectedRevision: number): Promise<FolderSummary>;
  /** Rejects with INVALID_MOVE when `parentId` is the folder or inside it. */
  moveFolder(folderId: string, parentId: string | null, expectedRevision: number): Promise<FolderSummary>;
  /** Soft-deletes the folder and everything in it (history kept). */
  deleteFolder(folderId: string, expectedRevision: number): Promise<{ deletedFiles: number; deletedFolders: number }>;
  /** Pending finalization may still commit later; it is not a failed upload. */
  uploadFile(workspaceId: string, file: File, target?: UploadTarget): Promise<{ id: string; version: number; pending?: false } | { pending: true }>;
  getFileBlob(fileId: string, version?: number): Promise<Blob>;
  readFile(fileId: string): Promise<FileDetail>;
  /** Rejects with VERSION_CONFLICT when `expectedVersion` isn't the head. */
  updateFileContent(
    fileId: string,
    update: FileUpdate,
  ): Promise<{ version: number }>;
  /** Appends the selected content as a new human-authored head; optimistic locking applies. */
  restoreRevision(fileId: string, version: number, expectedVersion: number): Promise<{ version: number }>;
  /** Newest first. Content may be omitted; fetch it with `getRevision`. */
  listRevisions(fileId: string): Promise<Revision[]>;
  /** One revision with its content, or null when that version doesn't exist. */
  getRevision(fileId: string, version: number): Promise<Revision | null>;
  /** The approved project context, or null when nothing has been approved yet. */
  getContext(workspaceId: string): Promise<ProjectContext | null>;
  getContextDetails(workspaceId: string): Promise<ContextDetails>;
  listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]>;
  updateContextField(workspaceId: string, input: ContextChangeInput & { expectedVersion: number; entryId?: string; entryIndex?: number }): Promise<{ version: number }>;
  proposeContextChange(workspaceId: string, input: ContextProposalInput): Promise<{ id: string; status: "pending" | "applied" }>;
  /** Newest first, cursor-paginated; maximum page size is 100. */
  listPublishedWork(workspaceId: string, cursor?: string | null, pageSize?: number): Promise<PublishedWorkPage>;
  /** Every status, newest updatedAt first, at most 100. Read-only: assistants manage tasks over MCP. */
  listTasks(workspaceId: string): Promise<Task[]>;
  /** "manual" (the default) holds every proposal for an owner or admin. */
  getContextApproval(workspaceId: string): Promise<ContextApproval>;
  /** Owner/admin humans only. Proposals already pending stay pending. */
  setContextApproval(workspaceId: string, mode: ContextApproval): Promise<void>;
  /** Newest first, at most 100. Every member may read them. */
  listProposals(workspaceId: string, status?: ProposalStatus): Promise<ContextProposal[]>;
  /**
   * Owner/admin humans only. Rejects with VERSION_CONFLICT when the field the
   * proposal was based on changed since (the backend marks it stale), with
   * PROPOSAL_DECIDED when someone else decided it first, and with
   * PROPOSAL_CHANGED when `expectedRevision` is behind (e.g. a verdict landed).
   */
  decideProposal(
    proposal: Pick<ContextProposal, "id" | "workspaceId">,
    decision: "approved" | "rejected",
    options?: DecideProposalOptions,
  ): Promise<void>;
  /**
   * Proposals that hit a conflict: `pending` wait on a person, `resolved` were
   * settled (newest first). Every member may read them.
   */
  listConflicts(workspaceId: string): Promise<ConflictList>;
  /** Owner/admin: runs a conflict check again when it is stuck on "checking". */
  recheckConflict(proposal: Pick<ContextProposal, "id" | "workspaceId">): Promise<void>;
  /** The MCP server URL people paste into their assistant. */
  getMcpServerUrl(): Promise<string>;
  /** Only the signed-in person's own API-key connection; the key is returned once. */
  createAgentConnection(
    workspaceId: string,
    input: { client: AgentClient; displayName?: string },
  ): Promise<NewAgentConnection>;
  /** The caller's own connections; owners/admins see everyone's. Never includes tokens. */
  listAgentConnections(workspaceId: string): Promise<AgentConnection[]>;
  /** Every unrevoked connection in the workspace, for any member; no people or credentials. */
  listAgentActivity(workspaceId: string): Promise<AgentActivity[]>;
  /** Also deletes its OAuth tokens or API key, so the next MCP call gets 401. */
  revokeAgentConnection(connectionId: string): Promise<void>;
  /** An assistant's pending OAuth request, or null when it expired or doesn't exist. */
  getConsentRequest(requestId: string): Promise<ConsentRequest | null>;
  /**
   * Approve (binding a new connection to `workspaceId`) or deny. Resolves to
   * the URL to send the browser back to; rejects with REQUEST_EXPIRED when the
   * request was already decided or timed out.
   */
  decideConsent(
    requestId: string,
    decision: { approve: true; workspaceId: string; client: AgentClient } | { approve: false },
  ): Promise<{ redirectUrl: string }>;
  /**
   * Calls `onChange` whenever a new workspace event lands (a file saved through
   * MCP, a proposal, an approval), so lists can refetch without a reload.
   * Returns an unsubscribe function.
   */
  watchWorkspace(workspaceId: string, onChange: () => void): () => void;
  /**
   * Live page: every unrevoked assistant, the approved-context version and how
   * far behind each one is. Reactive: `onData` runs on every change (including
   * read-only MCP calls). Returns an unsubscribe function.
   */
  watchAgentNetwork(workspaceId: string, subscriber: Subscriber<AgentNetwork>): () => void;
  /** The newest page of assistant activity and people's decisions, reactively. */
  watchTimeline(workspaceId: string, query: TimelineQuery, subscriber: Subscriber<TimelinePage>): () => void;
  /** One older page (`query.before` set), fetched once. */
  listTimeline(workspaceId: string, query: TimelineQuery): Promise<TimelinePage>;
}
