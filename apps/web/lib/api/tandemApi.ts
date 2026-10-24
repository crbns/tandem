import type {
  AgentClient,
  AgentConnection,
  ContextProposal,
  NewAgentConnection,
  ProposalStatus,
  CreateFileInput,
  CreateFolderInput,
  FileDetail,
  FileMove,
  FileSummary,
  FileUpdate,
  Folder,
  FolderMove,
  FolderRename,
  ProjectContext,
  Revision,
  Workspace,
  InviteRole,
  WorkspaceInvite,
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
  readFile(fileId: string): Promise<FileDetail>;
  /** Every folder in the workspace, flat; rebuild the tree from `parentId`. */
  listFolders(workspaceId: string): Promise<Folder[]>;
  /**
   * Rejects with NAME_EXISTS when the parent already holds a folder with this
   * name (trimmed, case-insensitive) and FOLDER_NOT_FOUND for a bad parent.
   */
  createFolder(workspaceId: string, input: CreateFolderInput): Promise<{ id: string }>;
  /**
   * Rejects with VERSION_CONFLICT when `expectedRevision` isn't current,
   * NAME_EXISTS when a sibling folder already has the name (a case-only rename
   * of the folder itself is fine), and FOLDER_NOT_FOUND for a missing folder.
   */
  renameFolder(folderId: string, rename: FolderRename): Promise<Folder>;
  /**
   * Moves a folder and everything in it. Rejects with FOLDER_CYCLE when the
   * destination is the folder or one of its subfolders, VERSION_CONFLICT,
   * NAME_EXISTS in the destination, and FOLDER_NOT_FOUND for either folder.
   */
  moveFolder(folderId: string, move: FolderMove): Promise<Folder>;
  /**
   * Moves a file without creating a new version. Rejects with VERSION_CONFLICT
   * when `expectedVersion` isn't the head, NAME_EXISTS when the destination
   * already holds a file with this name, and FOLDER_NOT_FOUND for a bad folder.
   */
  moveFile(fileId: string, move: FileMove): Promise<FileSummary>;
  /** Rejects with VERSION_CONFLICT when `expectedVersion` isn't the head. */
  updateFileContent(
    fileId: string,
    update: FileUpdate,
  ): Promise<{ version: number }>;
  /** Newest first. Content may be omitted; fetch it with `getRevision`. */
  listRevisions(fileId: string): Promise<Revision[]>;
  /** One revision with its content, or null when that version doesn't exist. */
  getRevision(fileId: string, version: number): Promise<Revision | null>;
  /** The approved project context, or null when nothing has been approved yet. */
  getContext(workspaceId: string): Promise<ProjectContext | null>;
  /** Newest first, at most 100. Every member may read them. */
  listProposals(workspaceId: string, status?: ProposalStatus): Promise<ContextProposal[]>;
  /**
   * Owner/admin humans only. Rejects with VERSION_CONFLICT when the field the
   * proposal was based on changed since (the backend marks it stale), and with
   * PROPOSAL_DECIDED when someone else decided it first.
   */
  decideProposal(
    proposal: Pick<ContextProposal, "id" | "workspaceId">,
    decision: "approved" | "rejected",
  ): Promise<void>;
  /** Only the signed-in person's own connection; the token is returned once. */
  createAgentConnection(
    workspaceId: string,
    input: { client: AgentClient; displayName?: string },
  ): Promise<NewAgentConnection>;
  /** The caller's own connections; owners/admins see everyone's. Never includes tokens. */
  listAgentConnections(workspaceId: string): Promise<AgentConnection[]>;
  revokeAgentConnection(connectionId: string): Promise<void>;
  /**
   * Calls `onChange` whenever a new workspace event lands (a file saved through
   * MCP, a proposal, an approval), so lists can refetch without a reload.
   * Returns an unsubscribe function.
   */
  watchWorkspace(workspaceId: string, onChange: () => void): () => void;
}
