import { randomUUID } from "node:crypto";
import {
  TandemError,
  fileNotFound,
  forbidden,
  nameExists,
  versionAhead,
  versionConflict,
} from "../errors.js";
import { nameKey, storedName } from "../names.js";
import type {
  Actor,
  Attribution,
  CreateDocumentInput,
  FileMetadata,
  FileWithContent,
  ListFilesInput,
  TandemBackend,
  UpdateDocumentInput,
} from "./types.js";

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
  readonly kind = "mock";
  private readonly members = new Map<string, Set<string>>([
    ["ws_demo", new Set(["user_alex", "user_sam"])],
    ["ws_other", new Set(["user_jordan"])],
  ]);
  private readonly files = new Map<string, StoredFile>();

  constructor() {
    const seededBy: Attribution = {
      actor_type: "agent",
      user_id: "user_alex",
      client: "seed",
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

  async readFile(actor: Actor, fileId: string): Promise<FileWithContent> {
    const file = this.getFile(actor, fileId);
    return { file: toMetadata(file), content: head(file).content };
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
    const name = storedName(input.name);
    const key = nameKey(name);
    if (!key) {
      throw new TandemError(
        "INVALID_INPUT",
        "name must contain at least one visible character.",
        { name: input.name },
      );
    }
    // No await between the check and the insert, so this is atomic in Node.
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
      name,
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
    const expected = input.expected_version;
    if (!Number.isSafeInteger(expected) || expected < 1) {
      throw new TandemError(
        "INVALID_INPUT",
        "expected_version must be a positive integer: the file.version returned by read_file.",
        { file_id: file.id, expected_version: expected },
      );
    }
    // Fail closed: anything other than an exact match is rejected.
    if (expected !== current) {
      throw expected > current
        ? versionAhead(file.id, current, expected)
        : versionConflict(file.id, current, expected);
    }
    file.revisions.push(newRevision(actor, current + 1, input.content));
    return toMetadata(file);
  }

  private resolveWorkspace(
    actor: Actor,
    workspaceId: string | undefined,
  ): string {
    if (workspaceId === undefined) {
      const first = [...this.members].find(([, users]) =>
        users.has(actor.user_id),
      );
      if (!first) {
        throw new TandemError(
          "FORBIDDEN",
          "You are not a member of any workspace. Ask a teammate to invite you in the Tandem dashboard.",
        );
      }
      return first[0];
    }
    if (!this.members.get(workspaceId)?.has(actor.user_id))
      throw forbidden(workspaceId);
    return workspaceId;
  }

  private getFile(actor: Actor, fileId: string): StoredFile {
    // Another tenant's file looks exactly like a missing one, so ids can't be probed.
    const file = this.files.get(fileId);
    if (!file || !this.members.get(file.workspace_id)?.has(actor.user_id))
      throw fileNotFound(fileId);
    return file;
  }
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
