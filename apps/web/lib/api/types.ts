// Shapes agreed with Person 2 (brief §2). There is no `packages/shared` and no
// Convex `Doc<>` types yet, so they live here. Swap for the backend's types once
// `convex/_generated` exists; components only import from this file.

export type ActorType = "human" | "agent";

export interface Actor {
  actorType: ActorType;
  actorId: string;
  actorName?: string;
}

export interface Workspace {
  id: string;
  name: string;
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
  content?: string;
}

export interface FileUpdate {
  expectedVersion: number;
  content: string;
}
