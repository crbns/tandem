import { TandemApiError } from "./errors";
import type { TandemApi } from "./tandemApi";
import type { Actor, FileDetail, FileSummary, ProjectContext, Revision, Workspace } from "./types";

export const MOCK_WORKSPACE_ID = "ws_demo";

export interface MockTandemApi extends TandemApi {
  /** Dev-only: pretend an assistant saved a new version through MCP. */
  __simulateExternalEdit(fileId: string, content: string, actor: Actor): void;
}

interface MockOptions {
  /** Inclusive [min, max] artificial latency per call. */
  latencyMs?: [number, number];
  /** Who the dashboard is acting as (the signed-in mock user). */
  getActor: () => Actor;
}

interface StoredFile {
  summary: FileSummary;
  content: string;
  revisions: Revision[]; // oldest first; append-only
}

// Alex's assistant: a teammate's Claude, so attribution has to say whose.
const CLAUDE: Actor = {
  actorType: "agent",
  userId: "user_alex",
  userName: "Alex",
  agentClient: "claude",
  agentName: "Claude",
};
const ALEX: Actor = { actorType: "human", userId: "user_alex", userName: "Alex" };
const DEMO: Actor = { actorType: "human", userId: "user_demo", userName: "Demo Human" };

const MINUTE = 60_000;

function seed(now: number): Map<string, StoredFile> {
  const files = new Map<string, StoredFile>();
  const add = (
    id: string,
    name: string,
    mimeType: string,
    history: Array<{ content: string; actor: Actor; at: number }>,
  ) => {
    const revisions: Revision[] = history.map((h, i) => ({
      ...h.actor,
      version: i + 1,
      createdAt: h.at,
      content: h.content,
    }));
    const head = history[history.length - 1]!;
    files.set(id, {
      content: head.content,
      revisions,
      summary: {
        id,
        workspaceId: MOCK_WORKSPACE_ID,
        parentId: null,
        name,
        mimeType,
        version: history.length,
        updatedAt: head.at,
        updatedBy: head.actor,
      },
    });
  };

  add("file_proposal", "proposal.md", "text/markdown", [
    {
      actor: CLAUDE,
      at: now - 3 * MINUTE,
      content:
        "# Project proposal\n\n## Goal\nShip the Tandem P0 demo by Saturday night.\n\n## Plan\n- MCP server with read/write tools\n- Dashboard with file list, editor, and history\n- Optimistic versioning on every write\n\n## Open questions\n- Which clients do we demo live?\n",
    },
  ]);
  add("file_brief", "brief.md", "text/markdown", [
    {
      actor: CLAUDE,
      at: now - 2 * 60 * MINUTE,
      content: "# Brief\n\nTandem keeps one canonical copy of team files.\n",
    },
    {
      actor: ALEX,
      at: now - 45 * MINUTE,
      content:
        "# Brief\n\nTandem keeps one canonical copy of team files that people **and** their assistants can read and write.\n\n| Who | Uses |\n|---|---|\n| Humans | Dashboard |\n| Assistants | MCP |\n",
    },
  ]);
  add("file_notes", "notes.txt", "text/plain", [
    {
      actor: DEMO,
      at: now - 26 * 60 * MINUTE,
      content: "Standup notes\n- Person 1: MCP auth\n- Person 2: schema\n- Person 3: dashboard\n",
    },
  ]);
  return files;
}

export function createMockApi({ latencyMs = [150, 400], getActor }: MockOptions): MockTandemApi {
  const files = seed(Date.now());
  const workspaces: Workspace[] = [{ id: MOCK_WORKSPACE_ID, name: "Cal Hacks Team" }];
  // Mock approved context, taken from the seeded proposal so it tells one story.
  const context: ProjectContext = {
    goal: "Ship the Tandem P0 demo by Saturday night.",
    scope: "One workspace, two members, a shared text file edited from the dashboard and through MCP.",
    constraints: ["Every write carries expectedVersion", "No agent-to-agent messaging"],
    decisions: ["Claude is the primary demo client", "Optimistic versioning on every write"],
    version: 2,
    approvedBy: ALEX,
    approvedAt: Date.now() - 50 * MINUTE,
  };
  let nextId = 1;

  const delay = () => {
    const [min, max] = latencyMs;
    const ms = min + Math.random() * (max - min);
    return ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve();
  };

  const getFile = (fileId: string): StoredFile => {
    const file = files.get(fileId);
    if (!file) throw new TandemApiError("FILE_NOT_FOUND");
    return file;
  };

  const commit = (file: StoredFile, content: string, actor: Actor) => {
    const now = Date.now();
    const version = file.summary.version + 1;
    file.content = content;
    file.summary = { ...file.summary, version, updatedAt: now, updatedBy: actor };
    file.revisions.push({ ...actor, version, createdAt: now, content });
    return version;
  };

  // Copies so callers can't mutate the store (revisions are immutable).
  const cloneSummary = (s: FileSummary): FileSummary => ({ ...s, updatedBy: { ...s.updatedBy } });

  return {
    async listWorkspaces() {
      await delay();
      return workspaces.map((w) => ({ ...w }));
    },

    async listFiles(workspaceId) {
      await delay();
      if (!workspaces.some((w) => w.id === workspaceId)) throw new TandemApiError("FORBIDDEN");
      return [...files.values()]
        .filter((f) => f.summary.workspaceId === workspaceId)
        .map((f) => ({ ...cloneSummary(f.summary), custody: f.revisions.map((r) => r.actorType) }));
    },

    async createFile(workspaceId, { name, mimeType, content }) {
      await delay();
      if (!workspaces.some((w) => w.id === workspaceId)) throw new TandemApiError("FORBIDDEN");
      const id = `file_new_${nextId++}`;
      const actor = getActor();
      const now = Date.now();
      files.set(id, {
        content,
        revisions: [{ ...actor, version: 1, createdAt: now, content }],
        summary: {
          id,
          workspaceId,
          parentId: null,
          name,
          mimeType,
          version: 1,
          updatedAt: now,
          updatedBy: actor,
        },
      });
      return { id, version: 1 };
    },

    async readFile(fileId) {
      await delay();
      const file = getFile(fileId);
      const detail: FileDetail = {
        ...cloneSummary(file.summary),
        content: file.content,
        permissions: { canEdit: true },
      };
      return detail;
    },

    async updateFileContent(fileId, { expectedVersion, content }) {
      await delay();
      const file = getFile(fileId);
      if (expectedVersion !== file.summary.version) {
        throw new TandemApiError("VERSION_CONFLICT", {
          currentVersion: file.summary.version,
          currentContent: file.content,
          updatedBy: { ...file.summary.updatedBy },
        });
      }
      return { version: commit(file, content, getActor()) };
    },

    async listRevisions(fileId) {
      await delay();
      return getFile(fileId)
        .revisions.map((r) => ({ ...r }))
        .reverse();
    },

    async getContext(workspaceId) {
      await delay();
      if (!workspaces.some((w) => w.id === workspaceId)) throw new TandemApiError("FORBIDDEN");
      return { ...context, approvedBy: { ...context.approvedBy } };
    },

    __simulateExternalEdit(fileId, content, actor) {
      commit(getFile(fileId), content, actor);
    },
  };
}
