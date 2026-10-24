import type {
  AgentClient,
  AgentConnection,
  ConsentRequest,
  ContextProposal,
  NewAgentConnection,
  ProposalStatus,
  CreateFileInput,
  FileDetail,
  FileSummary,
  FileUpdate,
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
  /** The MCP server URL people paste into their assistant. */
  getMcpServerUrl(): Promise<string>;
  /** Only the signed-in person's own API-key connection; the key is returned once. */
  createAgentConnection(
    workspaceId: string,
    input: { client: AgentClient; displayName?: string },
  ): Promise<NewAgentConnection>;
  /** The caller's own connections; owners/admins see everyone's. Never includes tokens. */
  listAgentConnections(workspaceId: string): Promise<AgentConnection[]>;
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
}
