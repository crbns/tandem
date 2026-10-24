import type {
  CreateFileInput,
  FileDetail,
  FileSummary,
  FileUpdate,
  ProjectContext,
  Revision,
  Workspace,
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
  /** Newest first. */
  listRevisions(fileId: string): Promise<Revision[]>;
  /** The approved project context, or null when nothing has been approved yet. */
  getContext(workspaceId: string): Promise<ProjectContext | null>;
}
