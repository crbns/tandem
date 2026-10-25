import { describe, expect, it } from "vitest";
import { createMockApi, MOCK_WORKSPACE_ID } from "@/lib/api/mock";
import type { Actor, ContextDetails, ContextEntry, FileSummary, FolderSummary } from "@/lib/api/types";
import { condenseTree, contextDigest, recentFiles, RECENT_ACTIVITY_MS, sortMembers, summarizeAgents } from "@/lib/overview";

const human: Actor = { actorType: "human", userId: "user_demo", userName: "Demo Human" };
const NOW = 1_000_000_000;
const MINUTE = 60_000;

const folder = (id: string, name: string, parentId: string | null): FolderSummary => ({
  id,
  workspaceId: "ws",
  parentId,
  name,
  path: `/${name}`,
  revision: 1,
  updatedAt: 0,
  updatedBy: human,
});

const file = (id: string, parentId: string | null, updatedAt = 0): FileSummary => ({
  id,
  workspaceId: "ws",
  parentId,
  name: `${id}.md`,
  mimeType: "text/markdown",
  version: 1,
  updatedAt,
  updatedBy: human,
});

const entry = (id: string, status: ContextEntry["status"] = "active"): ContextEntry => ({
  id,
  status,
  resolvedBy: null,
  resolvedAt: null,
  supersededBy: null,
  text: id,
  sourceFileIds: [],
  updatedBy: human,
  updatedAt: 0,
});

describe("summarizeAgents", () => {
  it("counts connections, recent activity from either time, and groups by client", () => {
    const summary = summarizeAgents(
      [
        { client: "claude", lastMcpActionAt: NOW - 2 * MINUTE },
        { client: "claude", lastSyncAt: NOW - RECENT_ACTIVITY_MS, lastMcpActionAt: NOW - 60 * MINUTE },
        { client: "chatgpt", lastMcpActionAt: NOW - RECENT_ACTIVITY_MS - 1 },
        { client: "gemini" },
      ],
      NOW,
    );
    expect(summary).toEqual({
      connected: 4,
      recentlyActive: 2,
      lastHeardAt: NOW - 2 * MINUTE,
      byClient: [
        { client: "claude", count: 2 },
        { client: "chatgpt", count: 1 },
        { client: "gemini", count: 1 },
      ],
    });
  });

  it("is empty with no connections", () => {
    expect(summarizeAgents([], NOW)).toEqual({ connected: 0, recentlyActive: 0, lastHeardAt: null, byClient: [] });
  });
});

describe("condenseTree", () => {
  const folders = [folder("a", "a", null), folder("b", "b", "a"), folder("c", "c", "b"), folder("z", "z", null)];
  const files = [file("deep", "c"), file("inA", "a"), file("old", null, 1), file("new", null, 2)];

  it("lists folders to depth 2 with subtree file counts, then root files newest first", () => {
    const tree = condenseTree(folders, files);
    // "c" sits below maxDepth: its file counts toward a and b, and it counts as hidden.
    expect(tree).toMatchObject({ hiddenFolders: 1, hiddenFiles: 0 });
    expect(
      tree.rows.map((row) => (row.kind === "folder" ? `${row.folder.name}:${row.depth}:${row.fileCount}` : row.file.id)),
    ).toEqual(["a:1:2", "b:2:1", "z:1:0", "new", "old"]);
  });

  it("caps folders and root files separately, so many folders never hide the root's files", () => {
    const many = Array.from({ length: 12 }, (_, i) => folder(`f${i}`, `f${String(i).padStart(2, "0")}`, null));
    const tree = condenseTree(many, [file("old", null, 1), file("new", null, 2), file("mid", null, 1.5)], {
      maxFolders: 8,
      maxFiles: 2,
    });
    expect(tree.rows.filter((row) => row.kind === "folder")).toHaveLength(8);
    expect(tree.rows.flatMap((row) => (row.kind === "file" ? [row.file.id] : []))).toEqual(["new", "mid"]);
    expect(tree).toMatchObject({ hiddenFolders: 4, hiddenFiles: 1 });
  });

  it("fills top-level folders before subfolders, so one folder's children never crowd out its siblings", () => {
    const busy = [
      folder("a", "a", null),
      ...Array.from({ length: 7 }, (_, i) => folder(`a${i}`, `a${i}`, "a")),
      folder("b", "b", null),
      folder("c", "c", null),
    ];
    const tree = condenseTree(busy, [], { maxFolders: 5 });
    // All three top-level folders, then a's first two children, still in tree order.
    expect(tree.rows.map((row) => (row.kind === "folder" ? row.folder.id : row.file.id))).toEqual([
      "a",
      "a0",
      "a1",
      "b",
      "c",
    ]);
    expect(tree).toMatchObject({ hiddenFolders: 5, hiddenFiles: 0 });
  });
});

describe("recentFiles", () => {
  it("returns the newest files first, up to the limit", () => {
    expect(recentFiles([file("a", null, 1), file("b", "x", 3), file("c", null, 2)], 2).map((f) => f.id)).toEqual([
      "b",
      "c",
    ]);
  });
});

describe("contextDigest", () => {
  it("keeps only active entries, in context page order", () => {
    const context: ContextDetails = {
      goal: entry("goal"),
      scope: null,
      constraints: [entry("c1"), entry("c2", "resolved")],
      decisions: [entry("d1", "superseded"), entry("d2")],
      ownership: [],
      openQuestions: [entry("q1")],
      version: 3,
    };
    expect(contextDigest(context).map(({ label, entries }) => [label, entries.map((e) => e.id)])).toEqual([
      ["Goal", ["goal"]],
      ["Scope", []],
      ["Constraints", ["c1"]],
      ["Decisions", ["d2"]],
      ["Ownership", []],
      ["Open questions", ["q1"]],
    ]);
  });
});

describe("mock listAgentActivity", () => {
  it("lists unrevoked connections without people or credentials", async () => {
    const api = createMockApi({ latencyMs: [0, 0], getActor: () => human });
    const before = await api.listAgentActivity(MOCK_WORKSPACE_ID);
    const created = await api.createAgentConnection(MOCK_WORKSPACE_ID, { client: "chatgpt" });
    const during = await api.listAgentActivity(MOCK_WORKSPACE_ID);
    expect(during).toHaveLength(before.length + 1);
    for (const activity of during) {
      expect(Object.keys(activity).every((key) => ["client", "lastMcpActionAt", "lastSyncAt"].includes(key))).toBe(true);
    }
    await api.revokeAgentConnection(created.connectionId);
    expect(await api.listAgentActivity(MOCK_WORKSPACE_ID)).toHaveLength(before.length);
  });
});

describe("sortMembers", () => {
  it("orders owners, admins, then members, by name within a role", () => {
    const sorted = sortMembers([
      { userId: "u1", name: "Zed", role: "member" },
      { userId: "u2", name: "Bea", role: "admin" },
      { userId: "u3", name: "Ana", role: "member" },
      { userId: "u4", name: "Cal", role: "owner" },
    ]);
    expect(sorted.map((m) => m.name)).toEqual(["Cal", "Bea", "Ana", "Zed"]);
  });
});

describe("mock listWorkspaceMembers", () => {
  it("includes each member's role", async () => {
    const api = createMockApi({ latencyMs: [0, 0], getActor: () => human });
    expect(await api.listWorkspaceMembers(MOCK_WORKSPACE_ID)).toContainEqual({
      userId: human.userId,
      name: "Demo Human",
      role: "owner",
    });
  });
});
