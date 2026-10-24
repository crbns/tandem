import { randomUUID } from "node:crypto";
import {
  TandemError,
  fileNotFound,
  forbidden,
  nameExists,
  versionAhead,
  versionConflict,
} from "../errors.js";
import type {
  Actor,
  Attribution,
  CreateDocumentInput,
  FileMetadata,
  FileVersions,
  FileWithContent,
  ListFilesInput,
  SearchFilesInput,
  SearchResult,
  TandemBackend,
  UpdateDocumentInput,
  WorkspaceRole,
  WorkspaceSummary,
} from "./types.js";

interface StoredWorkspace {
  name: string;
  members: Map<string, WorkspaceRole>;
}

interface Revision {
  version: number;
  content: string;
  created_at: string;
  created_by: Attribution;
}

interface StoredFile {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  name: string;
  mime_type: string;
  revisions: Revision[];
}

const SEED_BRIEF = `# Project brief

Goal: ship the Tandem demo for Cal Hacks.
`;

/** In-memory backend for local development and tests. State is lost on restart. */
export class MockBackend implements TandemBackend {
  // Insertion order matters: an actor's first workspace is their default.
  private readonly workspaces = new Map<string, StoredWorkspace>([
    [
      "ws_demo",
      {
        name: "Demo workspace",
        members: new Map([
          ["user_alex", "owner"],
          ["user_sam", "member"],
        ]),
      },
    ],
    [
      "ws_other",
      { name: "Other workspace", members: new Map([["user_jordan", "owner"]]) },
    ],
  ]);
  private readonly files = new Map<string, StoredFile>();

  constructor() {
    const seededBy: Attribution = {
      actor_type: "human",
      user_id: "user_sam",
      client: "dashboard",
    };
    this.files.set("file_brief", {
      id: "file_brief",
      workspace_id: "ws_demo",
      parent_id: null,
      name: "brief.md",
      mime_type: "text/markdown",
      revisions: [
        {
          version: 1,
          content: SEED_BRIEF,
          created_at: new Date().toISOString(),
          created_by: seededBy,
        },
      ],
    });
  }

  async listWorkspaces(actor: Actor): Promise<WorkspaceSummary[]> {
    const mine = [...this.workspaces].filter(([, ws]) =>
      ws.members.has(actor.user_id),
    );
    return mine.map(([id, ws], i) => ({
      id,
      name: ws.name,
      role: ws.members.get(actor.user_id)!,
      member_count: ws.members.size,
      is_default: i === 0,
    }));
  }

  async listFiles(
    actor: Actor,
    input: ListFilesInput,
  ): Promise<FileMetadata[]> {
    const workspaceId = this.resolveWorkspace(actor, input.workspace_id);
    // No folders in the mock yet, so no folder_id can name a valid folder.
    if (input.folder_id !== undefined) {
      throw new TandemError(
        "INVALID_INPUT",
        "Folders are not supported yet; omit folder_id.",
        { folder_id: input.folder_id },
      );
    }
    const query = input.query?.toLowerCase();
    return [...this.files.values()]
      .filter((f) => f.workspace_id === workspaceId)
      .filter(
        (f) => query === undefined || f.name.toLowerCase().includes(query),
      )
      .map(toMetadata);
  }

  async searchFiles(
    actor: Actor,
    input: SearchFilesInput,
  ): Promise<SearchResult[]> {
    const workspaceId = this.resolveWorkspace(actor, input.workspace_id);
    const query = input.query.toLowerCase();
    const results: SearchResult[] = [];
    for (const f of this.files.values()) {
      if (f.workspace_id !== workspaceId) continue;
      const content = head(f).content;
      const nameMatch = f.name.toLowerCase().includes(query);
      const at = content.toLowerCase().indexOf(query);
      if (!nameMatch && at === -1) continue;
      results.push({
        file: toMetadata(f),
        snippet:
          at === -1
            ? snippet(content, 0, 0)
            : snippet(content, at, query.length),
        match: nameMatch ? "name" : "content",
      });
    }
    return results
      .sort(
        (a, b) =>
          Number(b.match === "name") - Number(a.match === "name") ||
          b.file.updated_at.localeCompare(a.file.updated_at),
      )
      .slice(0, input.limit);
  }

  async readFile(actor: Actor, fileId: string): Promise<FileWithContent> {
    const file = this.getFile(actor, fileId);
    return { file: toMetadata(file), content: head(file).content };
  }

  async getFileVersions(
    actor: Actor,
    fileId: string,
    limit: number,
  ): Promise<FileVersions> {
    const file = this.getFile(actor, fileId);
    const versions = file.revisions
      .slice()
      .reverse()
      .slice(0, limit)
      .map((r) => ({
        version: r.version,
        created_at: r.created_at,
        author: r.created_by,
        size_bytes: Buffer.byteLength(r.content, "utf8"),
      }));
    return { file: toMetadata(file), versions };
  }

  async createDocument(
    actor: Actor,
    input: CreateDocumentInput,
  ): Promise<FileMetadata> {
    const workspaceId = this.resolveWorkspace(actor, input.workspace_id);
    // No folders in the mock yet, so no parent_id can name a valid folder.
    if (input.parent_id !== undefined) {
      throw new TandemError(
        "INVALID_INPUT",
        "Folders are not supported yet; omit parent_id.",
        { parent_id: input.parent_id },
      );
    }
    const key = nameKey(input.name);
    const existing = [...this.files.values()].find(
      (f) =>
        f.workspace_id === workspaceId &&
        f.parent_id === null &&
        nameKey(f.name) === key,
    );
    if (existing) {
      throw nameExists(existing.id, existing.name, head(existing).version);
    }
    const file: StoredFile = {
      id: `file_${randomUUID()}`,
      workspace_id: workspaceId,
      parent_id: null,
      name: input.name,
      mime_type: input.mime_type,
      revisions: [newRevision(actor, 1, input.content)],
    };
    this.files.set(file.id, file);
    return toMetadata(file);
  }

  async updateDocument(
    actor: Actor,
    input: UpdateDocumentInput,
  ): Promise<FileMetadata> {
    const file = this.getFile(actor, input.file_id);
    const current = head(file).version;
    if (input.expected_version > current) {
      throw versionAhead(file.id, current, input.expected_version);
    }
    if (input.expected_version < current) {
      throw versionConflict(file.id, current, input.expected_version);
    }
    file.revisions.push(newRevision(actor, current + 1, input.content));
    return toMetadata(file);
  }

  private resolveWorkspace(
    actor: Actor,
    workspaceId: string | undefined,
  ): string {
    if (workspaceId === undefined) {
      const first = [...this.workspaces].find(([, ws]) =>
        ws.members.has(actor.user_id),
      );
      if (!first) {
        throw new TandemError(
          "FORBIDDEN",
          "You are not a member of any workspace. Ask a teammate to invite you in the Tandem dashboard.",
        );
      }
      return first[0];
    }
    if (!this.isMember(actor, workspaceId)) throw forbidden(workspaceId);
    return workspaceId;
  }

  private getFile(actor: Actor, fileId: string): StoredFile {
    // Another tenant's file looks exactly like a missing one, so ids can't be probed.
    const file = this.files.get(fileId);
    if (!file || !this.isMember(actor, file.workspace_id))
      throw fileNotFound(fileId);
    return file;
  }

  private isMember(actor: Actor, workspaceId: string): boolean {
    return (
      this.workspaces.get(workspaceId)?.members.has(actor.user_id) ?? false
    );
  }
}

const SNIPPET_CHARS = 160;

/** ~SNIPPET_CHARS of `content` centred on [at, at+length), whitespace collapsed. */
function snippet(content: string, at: number, length: number): string {
  const lead = Math.max(0, Math.floor((SNIPPET_CHARS - length) / 2));
  const start = Math.max(
    0,
    Math.min(at - lead, content.length - SNIPPET_CHARS),
  );
  const end = start + SNIPPET_CHARS;
  const text = content.slice(start, end).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + text + (end < content.length ? "…" : "");
}

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

function head(file: StoredFile): Revision {
  return file.revisions[file.revisions.length - 1]!;
}

function newRevision(actor: Actor, version: number, content: string): Revision {
  return {
    version,
    content,
    created_at: new Date().toISOString(),
    created_by: {
      actor_type: "agent",
      user_id: actor.user_id,
      client: actor.client,
    },
  };
}

function toMetadata(file: StoredFile): FileMetadata {
  const latest = head(file);
  return {
    id: file.id,
    workspace_id: file.workspace_id,
    parent_id: file.parent_id,
    name: file.name,
    mime_type: file.mime_type,
    version: latest.version,
    updated_at: latest.created_at,
    updated_by: latest.created_by,
  };
}
