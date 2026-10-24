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
}

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
