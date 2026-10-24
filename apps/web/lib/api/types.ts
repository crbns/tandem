// Shapes agreed with Person 2 (brief §2). There is no `packages/shared` and no
// Convex `Doc<>` types yet, so they live here. Swap for the backend's types once
// `convex/_generated` exists; components only import from this file.

export type ActorType = "human" | "agent";

/**
 * Who made a change: always a person, plus the assistant when an agent wrote it
 * (AGENTS.md: attribution names both person and agent). Mirrors MCP's
 * `Attribution { actor_type, user_id, client }` in camelCase.
 */
export interface Actor {
  actorType: ActorType;
  /** The human who saved, or whose assistant saved. */
  userId: string;
  userName?: string;
  /** Agent writes only: the assistant client id (e.g. "claude", "chatgpt"). */
  agentClient?: string;
  /** Agent writes only: display name for the assistant (e.g. "Claude"). */
  agentName?: string;
}

export interface Workspace {
  id: string;
  name: string;
  role?: "owner" | "admin" | "member";
}

export type InviteRole = "admin" | "member";

export interface WorkspaceInvite {
  id: string;
  workspaceId: string;
  role: InviteRole;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  acceptedBy?: string;
  acceptedAt?: number;
  revokedAt?: number;
  updatedAt: number;
}

export interface FileSummary {
  id: string;
  workspaceId: string;
  parentId: string | null;
  name: string;
  mimeType: string;
  version: number;
  updatedAt: number;
  updatedBy: Actor;
  /** Optional: actor type of each recent version, oldest first, head last. */
  custody?: ActorType[];
  /** `/specs/api.md`; set by directory listings (docs/filesystem.md). */
  path?: string;
}

/** A folder in the workspace tree. `parentId` null is the workspace root. */
export interface FolderSummary {
  id: string;
  workspaceId: string;
  parentId: string | null;
  name: string;
  /** `/specs/api`; no trailing slash. */
  path: string;
  /** Optimistic-lock counter for rename, move and delete. */
  revision: number;
  updatedAt: number;
  updatedBy: Actor;
}

/** One folder's immediate children, as the directory browser shows them. */
export interface DirectoryListing {
  /** `null` at the workspace root. */
  folder: FolderSummary | null;
  /** Root first; the root itself is implied. */
  breadcrumbs: { id: string; name: string }[];
  folders: FolderSummary[];
  files: FileSummary[];
}

export interface FileDetail extends FileSummary {
  /** `null` for binary files, which the dashboard doesn't edit in P0. */
  content: string | null;
  permissions: { canEdit: boolean };
}

export interface Revision extends Actor {
  version: number;
  createdAt: number;
  /** Omitted when the backend only returns revision metadata. */
  content?: string;
}

export interface CreateFileInput {
  name: string;
  mimeType: string;
  /** Required by the shared contract (MCP's createDocument requires it too). */
  content: string;
  /** Folder to create it in; omitted or null is the workspace root. */
  parentId?: string | null;
}

/** A new version of an existing binary, or a new file in a folder (null = root). */
export type UploadTarget = { fileId: string; expectedVersion: number } | { parentId: string | null };

/**
 * The approved project context: changes to it need a human's approval, so the
 * dashboard only ever shows the approved version (read-only in P0).
 */
export interface ProjectContext {
  goal: string;
  scope: string;
  constraints: string[];
  decisions: string[];
  version: number;
  approvedBy: Actor;
  approvedAt: number;
}

export interface FileUpdate {
  expectedVersion: number;
  content: string;
}

/** Assistant apps a person can connect through MCP. */
export const AGENT_CLIENTS = ["claude", "chatgpt", "gemini", "other"] as const;
export type AgentClient = (typeof AGENT_CLIENTS)[number];

/**
 * How a connection signs in to the MCP server: an API key (Claude Code,
 * scripts) or OAuth through the consent page (claude.ai and other connectors).
 */
export type AgentAuthKind = "api_key" | "oauth";

/**
 * One assistant a person connected to one workspace. An API key is only ever
 * returned by `createAgentConnection`, once. Times are what the backend last
 * saw over MCP; they never mean the assistant is "online".
 */
export interface AgentConnection {
  id: string;
  userId: string;
  userName?: string;
  client: string;
  displayName?: string;
  /** Absent on legacy token connections, which no longer work. */
  authKind?: AgentAuthKind;
  /** OAuth only: the name the client gave itself. Unverified. */
  oauthClientName?: string;
  createdAt: number;
  lastMcpActionAt?: number;
  lastSyncAt?: number;
  revokedAt?: number;
}

export interface NewAgentConnection {
  connectionId: string;
  /** Plaintext API key. Shown once; the backend only keeps its hash. */
  token: string;
  createdAt: number;
  /** The MCP server URL to configure next to the key. */
  mcpUrl: string;
}

export interface OAuthScope {
  name: string;
  description: string;
}

/** An assistant asking to connect over OAuth, as the consent page shows it. */
export interface ConsentRequest {
  status: "pending" | "approved" | "denied";
  /** Self-reported by the assistant when it registered. Unverified. */
  clientName?: string;
  /** Where the assistant receives access, e.g. "claude.ai". */
  redirectHost?: string;
  suggestedClient: AgentClient;
  scopes: OAuthScope[];
  /** Workspaces the signed-in person can connect it to. */
  workspaces: { id: string; name: string; role: "owner" | "admin" | "member" }[];
}

export type ContextField = "goal" | "scope" | "constraint" | "decision" | "ownership" | "open_question";
export type ProposalStatus = "pending" | "approved" | "rejected" | "stale" | "applied";

/** A proposed change to the project context, waiting on (or decided by) a person. */
export interface ContextProposal {
  id: string;
  workspaceId: string;
  field: ContextField;
  proposedValue: string;
  rationale: string;
  sourceFileIds: string[];
  status: ProposalStatus;
  supersedes: string | null;
  createdBy: Actor;
  createdAt: number;
  decidedBy: Actor | null;
  decidedAt: number | null;
}

/** Context entries retain their canonical sources and the human decision's attribution. */
export interface ContextEntry {
  id: string;
  status: "active" | "resolved" | "superseded";
  resolvedBy: Actor | null;
  resolvedAt: number | null;
  supersededBy: string | null;
  text: string;
  sourceFileIds: string[];
  updatedBy: Actor;
  updatedAt: number;
  ownerUserId?: string | null;
  ownerArea?: string | null;
}

export interface ContextDetails {
  goal: ContextEntry | null;
  scope: ContextEntry | null;
  constraints: ContextEntry[];
  decisions: ContextEntry[];
  ownership: ContextEntry[];
  openQuestions: ContextEntry[];
  version: number;
}

export interface ContextChangeInput {
  field: ContextField;
  proposedValue: string;
  sourceFileIds: string[];
  ownerUserId?: string;
}

export interface PublishedWork {
  id: string;
  workspaceId: string;
  kind: "deliverable" | "finding";
  title: string;
  summary: string;
  fileIds: string[];
  createdBy: Actor;
  createdAt: number;
}

export interface PublishedWorkPage {
  page: PublishedWork[];
  isDone: boolean;
  continueCursor: string;
}

export interface WorkspaceMember {
  userId: string;
  name: string;
}

export interface ContextProposalInput extends Omit<ContextChangeInput, "proposedValue"> {
  proposedValue?: string;
  rationale: string;
  operation?: "add" | "resolve" | "remove";
  entryId?: string;
  supersedes?: string;
  expectedVersion?: number;
}
