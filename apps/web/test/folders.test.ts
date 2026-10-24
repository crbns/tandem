import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import type { ConvexReactClient } from "convex/react";
import { getFunctionName, type FunctionReference, type FunctionReturnType } from "convex/server";
import type { api } from "@repo/backend/convex/_generated/api.js";
import type { Id } from "@repo/backend/convex/_generated/dataModel.js";
import { createConvexApi } from "@/lib/api/convex";
import { normalizeError, TandemApiError } from "@/lib/api/errors";
import {
  CREATE_FOLDER_ERROR_COPY,
  ERROR_COPY,
  MOVE_ERROR_COPY,
  MOVE_FOLDER_ERROR_COPY,
  RENAME_FOLDER_ERROR_COPY,
} from "@/lib/api/errorCopy";
import { createMockApi, MOCK_WORKSPACE_ID, type MockTandemApi } from "@/lib/api/mock";
import type { Actor, Folder } from "@/lib/api/types";
import {
  childFolders,
  findFolder,
  folderHref,
  folderPath,
  folderSubtree,
  folderTree,
  parseNewFolderName,
} from "@/lib/files";

const human: Actor = { actorType: "human", userId: "user_demo", userName: "Demo Human" };

async function expectApiError(promise: Promise<unknown>) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TandemApiError);
  return err as TandemApiError;
}

describe("mock TandemApi folders", () => {
  let api: MockTandemApi;
  const newFile = (name: string, parentId: string | null = null) =>
    api.createFile(MOCK_WORKSPACE_ID, { name, mimeType: "text/markdown", content: "# x", parentId });

  beforeEach(() => {
    api = createMockApi({ latencyMs: [0, 0], getActor: () => human });
  });

  it("creates top-level and nested folders, trimmed and attributed", async () => {
    const { id: research } = await api.createFolder(MOCK_WORKSPACE_ID, { name: "  Research  " });
    const { id: interviews } = await api.createFolder(MOCK_WORKSPACE_ID, { name: "Interviews", parentId: research });
    const folders = await api.listFolders(MOCK_WORKSPACE_ID);
    expect(folders).toHaveLength(2);
    expect(findFolder(folders, research)).toMatchObject({ name: "Research", parentId: null, updatedBy: human });
    expect(findFolder(folders, interviews)).toMatchObject({ name: "Interviews", parentId: research });
  });

  it("rejects a duplicate folder name in the same parent, ignoring case and spaces", async () => {
    const { id: research } = await api.createFolder(MOCK_WORKSPACE_ID, { name: "Research" });
    const err = await expectApiError(api.createFolder(MOCK_WORKSPACE_ID, { name: " research " }));
    expect(err.code).toBe("NAME_EXISTS");
    expect(err.details.existingName).toBe("Research");
    // Same name in another parent is fine; files and folders don't collide.
    await api.createFolder(MOCK_WORKSPACE_ID, { name: "Research", parentId: research });
    await newFile("Research");
    expect(await api.listFolders(MOCK_WORKSPACE_ID)).toHaveLength(2);
  });

  it("rejects an empty name and an unknown parent", async () => {
    expect((await expectApiError(api.createFolder(MOCK_WORKSPACE_ID, { name: "   " }))).code).toBe("INVALID_INPUT");
    expect((await expectApiError(api.createFolder(MOCK_WORKSPACE_ID, { name: "x", parentId: "folder_nope" }))).code).toBe(
      "FOLDER_NOT_FOUND",
    );
    expect((await expectApiError(api.createFolder("ws_other", { name: "x" }))).code).toBe("FORBIDDEN");
  });

  it("creates a file inside a folder and rejects a duplicate name there", async () => {
    const { id: folder } = await api.createFolder(MOCK_WORKSPACE_ID, { name: "Docs" });
    const { id } = await newFile("plan.md", folder);
    expect((await api.readFile(id)).parentId).toBe(folder);
    expect((await expectApiError(newFile("PLAN.md", folder))).code).toBe("NAME_EXISTS");
    expect((await expectApiError(newFile("x.md", "folder_nope"))).code).toBe("FOLDER_NOT_FOUND");
  });

  it("moves a file into a folder and back to the top level without a new version", async () => {
    const { id: folder } = await api.createFolder(MOCK_WORKSPACE_ID, { name: "Docs" });
    const before = await api.readFile("file_brief");
    const moved = await api.moveFile("file_brief", { parentId: folder, expectedVersion: before.version });
    expect(moved).toMatchObject({ id: "file_brief", parentId: folder, version: before.version });
    expect((await api.readFile("file_brief")).content).toBe(before.content);
    expect(await api.listRevisions("file_brief")).toHaveLength(before.version);

    const back = await api.moveFile("file_brief", { parentId: null, expectedVersion: before.version });
    expect(back).toMatchObject({ parentId: null, version: before.version });
  });

  it("rejects a move from a stale version", async () => {
    const { id: folder } = await api.createFolder(MOCK_WORKSPACE_ID, { name: "Docs" });
    await api.updateFileContent("file_notes", { expectedVersion: 1, content: "newer" });
    const err = await expectApiError(api.moveFile("file_notes", { parentId: folder, expectedVersion: 1 }));
    expect(err.code).toBe("VERSION_CONFLICT");
    expect(err.details.currentVersion).toBe(2);
    expect((await api.readFile("file_notes")).parentId).toBeNull();
  });

  it("rejects a move onto a file with the same name, and to an unknown folder", async () => {
    const { id: folder } = await api.createFolder(MOCK_WORKSPACE_ID, { name: "Docs" });
    await newFile("Notes.TXT", folder);
    const err = await expectApiError(api.moveFile("file_notes", { parentId: folder, expectedVersion: 1 }));
    expect(err.code).toBe("NAME_EXISTS");
    expect(err.details.existingName).toBe("Notes.TXT");
    expect((await expectApiError(api.moveFile("file_notes", { parentId: "folder_nope", expectedVersion: 1 }))).code).toBe(
      "FOLDER_NOT_FOUND",
    );
    expect((await api.readFile("file_notes")).parentId).toBeNull();
  });

  it("notifies workspace watchers on folder create and file move", async () => {
    const onChange = vi.fn();
    const stop = api.watchWorkspace(MOCK_WORKSPACE_ID, onChange);
    const { id: folder } = await api.createFolder(MOCK_WORKSPACE_ID, { name: "Docs" });
    await api.moveFile("file_notes", { parentId: folder, expectedVersion: 1 });
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe("mock TandemApi folder rename and move", () => {
  let api: MockTandemApi;
  const folderNamed = async (id: string) => findFolder(await api.listFolders(MOCK_WORKSPACE_ID), id)!;
  const mkdir = async (name: string, parentId: string | null = null) =>
    (await api.createFolder(MOCK_WORKSPACE_ID, { name, parentId })).id;

  beforeEach(() => {
    api = createMockApi({ latencyMs: [0, 0], getActor: () => human });
  });

  it("starts folders at revision 1 and bumps it on rename", async () => {
    const id = await mkdir("Drafts");
    expect((await folderNamed(id)).revision).toBe(1);
    const renamed = await api.renameFolder(id, { name: "  specs  ", expectedRevision: 1 });
    expect(renamed).toMatchObject({ id, name: "specs", revision: 2, parentId: null, updatedBy: human });
    expect(await folderNamed(id)).toMatchObject({ name: "specs", revision: 2 });
  });

  it("rejects a rename from a stale revision and reports the current one", async () => {
    const id = await mkdir("Drafts");
    await api.renameFolder(id, { name: "Specs", expectedRevision: 1 });
    const err = await expectApiError(api.renameFolder(id, { name: "Other", expectedRevision: 1 }));
    expect(err.code).toBe("VERSION_CONFLICT");
    expect(err.details.currentRevision).toBe(2);
    expect((await folderNamed(id)).name).toBe("Specs");
  });

  it("rejects a sibling name clash ignoring case, but allows a case-only rename", async () => {
    const research = await mkdir("Research");
    const drafts = await mkdir("Drafts");
    const err = await expectApiError(api.renameFolder(drafts, { name: "RESEARCH", expectedRevision: 1 }));
    expect(err.code).toBe("NAME_EXISTS");
    expect(err.details.existingName).toBe("Research");
    expect(await api.renameFolder(research, { name: "research", expectedRevision: 1 })).toMatchObject({
      name: "research",
      revision: 2,
    });
    // The same name in another parent is fine.
    const nested = await mkdir("Drafts", research);
    expect((await api.renameFolder(nested, { name: "Research", expectedRevision: 1 })).name).toBe("Research");
  });

  it("treats an identical name as a no-op and rejects empty names and unknown folders", async () => {
    const id = await mkdir("Drafts");
    expect(await api.renameFolder(id, { name: " Drafts ", expectedRevision: 1 })).toMatchObject({ revision: 1 });
    expect((await expectApiError(api.renameFolder(id, { name: "  ", expectedRevision: 1 }))).code).toBe("INVALID_INPUT");
    expect((await expectApiError(api.renameFolder("folder_nope", { name: "x", expectedRevision: 1 }))).code).toBe(
      "FOLDER_NOT_FOUND",
    );
  });

  it("moves a folder with its contents into another folder and back to the top level", async () => {
    const specs = await mkdir("specs");
    const drafts = await mkdir("drafts");
    const inner = await mkdir("api", drafts);
    const { id: file } = await api.createFile(MOCK_WORKSPACE_ID, {
      name: "plan.md",
      mimeType: "text/markdown",
      content: "# plan",
      parentId: drafts,
    });

    const moved = await api.moveFolder(drafts, { parentId: specs, expectedRevision: 1 });
    expect(moved).toMatchObject({ id: drafts, parentId: specs, revision: 2 });
    // Children keep their parent, so the whole subtree comes along.
    expect((await folderNamed(inner)).parentId).toBe(drafts);
    expect((await api.readFile(file)).parentId).toBe(drafts);
    const folders = await api.listFolders(MOCK_WORKSPACE_ID);
    expect(folderPath(folders, findFolder(folders, inner)).map((f) => f.name)).toEqual(["specs", "drafts", "api"]);

    expect(await api.moveFolder(drafts, { parentId: null, expectedRevision: 2 })).toMatchObject({
      parentId: null,
      revision: 3,
    });
    // Moving to where it already is changes nothing.
    expect(await api.moveFolder(drafts, { parentId: null, expectedRevision: 3 })).toMatchObject({ revision: 3 });
  });

  it("rejects moving a folder into itself or any of its subfolders", async () => {
    const a = await mkdir("a");
    const child = await mkdir("child", a);
    const grand = await mkdir("grand", child);
    for (const target of [a, child, grand]) {
      expect((await expectApiError(api.moveFolder(a, { parentId: target, expectedRevision: 1 }))).code).toBe("FOLDER_CYCLE");
    }
    expect((await folderNamed(a)).parentId).toBeNull();
    // A subfolder can still move up and out.
    expect((await api.moveFolder(grand, { parentId: null, expectedRevision: 1 })).parentId).toBeNull();
  });

  it("rejects a stale move, a name clash in the destination and an unknown destination", async () => {
    const specs = await mkdir("specs");
    await mkdir("Drafts", specs);
    const drafts = await mkdir("drafts");
    await api.renameFolder(drafts, { name: "DRAFTS", expectedRevision: 1 });

    const stale = await expectApiError(api.moveFolder(drafts, { parentId: specs, expectedRevision: 1 }));
    expect(stale.code).toBe("VERSION_CONFLICT");
    expect(stale.details.currentRevision).toBe(2);

    const clash = await expectApiError(api.moveFolder(drafts, { parentId: specs, expectedRevision: 2 }));
    expect(clash.code).toBe("NAME_EXISTS");
    expect(clash.details.existingName).toBe("Drafts");

    expect((await expectApiError(api.moveFolder(drafts, { parentId: "folder_nope", expectedRevision: 2 }))).code).toBe(
      "FOLDER_NOT_FOUND",
    );
    expect((await folderNamed(drafts)).parentId).toBeNull();
  });

  it("notifies workspace watchers on rename and move", async () => {
    const specs = await mkdir("specs");
    const drafts = await mkdir("drafts");
    const onChange = vi.fn();
    const stop = api.watchWorkspace(MOCK_WORKSPACE_ID, onChange);
    await api.renameFolder(drafts, { name: "Drafts", expectedRevision: 1 });
    await api.moveFolder(drafts, { parentId: specs, expectedRevision: 2 });
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledTimes(2);
    stop();
  });
});

// Fixtures typed from the generated function types, as in convexAdapter.test.ts.
type BackendFolders = FunctionReturnType<typeof api.files.listFolders>;
type BackendFile = FunctionReturnType<typeof api.files.moveFile>;
type RenamedFolder = FunctionReturnType<typeof api.workspaces.renameFolder>;
type MovedFolder = FunctionReturnType<typeof api.workspaces.moveFolder>;

const ALEX = { type: "human" as const, userId: "users_alex" as Id<"users">, label: "Alex" };
const FOLDERS: BackendFolders = {
  folders: [
    {
      id: "folders_1" as Id<"folders">,
      workspaceId: "workspaces_1" as Id<"workspaces">,
      parentId: null,
      name: "Research",
      revision: 1,
      updatedAt: 1,
      updatedBy: ALEX,
    },
  ],
  truncated: false,
};
const MOVED: BackendFile = {
  id: "files_1" as Id<"files">,
  workspaceId: "workspaces_1" as Id<"workspaces">,
  parentId: "folders_1" as Id<"folders">,
  name: "plan.md",
  mimeType: "text/markdown",
  version: 3,
  updatedAt: 2,
  updatedBy: ALEX,
};

function fakeConvex(responses: Record<string, unknown>) {
  const calls: { name: string; args: unknown }[] = [];
  const run = async (ref: FunctionReference<"query" | "mutation">, args: unknown) => {
    const name = getFunctionName(ref);
    calls.push({ name, args });
    const res = responses[name];
    if (res instanceof Error) throw res;
    if (res === undefined) throw new Error(`no fixture for ${name}`);
    return res;
  };
  const client = { query: run, mutation: run } as unknown as ConvexReactClient;
  return { client, calls };
}

describe("createConvexApi folders", () => {
  it("calls listFolders, createFolder and moveFile with exact args", async () => {
    const { client, calls } = fakeConvex({
      "files:listFolders": FOLDERS,
      "workspaces:createFolder": "folders_2",
      "files:moveFile": MOVED,
      "files:createDocument": { ...MOVED, id: "files_2", version: 1 },
    });
    const tandem = createConvexApi(client);

    expect(await tandem.listFolders("workspaces_1")).toEqual([
      {
        id: "folders_1",
        workspaceId: "workspaces_1",
        parentId: null,
        name: "Research",
        revision: 1,
        updatedAt: 1,
        updatedBy: { actorType: "human", userId: "users_alex", userName: "Alex" },
      },
    ]);
    expect(await tandem.createFolder("workspaces_1", { name: "Top" })).toEqual({ id: "folders_2" });
    expect(await tandem.createFolder("workspaces_1", { name: "Nested", parentId: "folders_1" })).toEqual({
      id: "folders_2",
    });
    expect(await tandem.moveFile("files_1", { parentId: "folders_1", expectedVersion: 3 })).toMatchObject({
      id: "files_1",
      parentId: "folders_1",
      version: 3,
    });
    await tandem.moveFile("files_1", { parentId: null, expectedVersion: 3 });
    await tandem.createFile("workspaces_1", { name: "a.md", mimeType: "text/markdown", content: "", parentId: "folders_1" });
    await tandem.createFile("workspaces_1", { name: "b.md", mimeType: "text/markdown", content: "", parentId: null });

    expect(calls).toEqual([
      { name: "files:listFolders", args: { workspaceId: "workspaces_1" } },
      // The backend's parentId is optional, never null, for the top level.
      { name: "workspaces:createFolder", args: { workspaceId: "workspaces_1", name: "Top" } },
      { name: "workspaces:createFolder", args: { workspaceId: "workspaces_1", name: "Nested", parentId: "folders_1" } },
      { name: "files:moveFile", args: { fileId: "files_1", parentId: "folders_1", expectedVersion: 3 } },
      { name: "files:moveFile", args: { fileId: "files_1", parentId: null, expectedVersion: 3 } },
      {
        name: "files:createDocument",
        args: { workspaceId: "workspaces_1", name: "a.md", mimeType: "text/markdown", content: "", parentId: "folders_1" },
      },
      { name: "files:createDocument", args: { workspaceId: "workspaces_1", name: "b.md", mimeType: "text/markdown", content: "" } },
    ]);
  });

  it("calls renameFolder and moveFolder with exact args and maps the result", async () => {
    const folder = FOLDERS.folders[0]!;
    const { client, calls } = fakeConvex({
      "workspaces:renameFolder": { ...folder, name: "specs", revision: 2 } satisfies RenamedFolder,
      "workspaces:moveFolder": { ...folder, parentId: "folders_2" as Id<"folders">, revision: 3 } satisfies MovedFolder,
    });
    const tandem = createConvexApi(client);

    expect(await tandem.renameFolder("folders_1", { name: "specs", expectedRevision: 1 })).toMatchObject({
      id: "folders_1",
      name: "specs",
      revision: 2,
      updatedBy: { actorType: "human", userName: "Alex" },
    });
    expect(await tandem.moveFolder("folders_1", { parentId: "folders_2", expectedRevision: 2 })).toMatchObject({
      parentId: "folders_2",
      revision: 3,
    });
    await tandem.moveFolder("folders_1", { parentId: null, expectedRevision: 3 });

    expect(calls).toEqual([
      { name: "workspaces:renameFolder", args: { folderId: "folders_1", name: "specs", expectedRevision: 1 } },
      { name: "workspaces:moveFolder", args: { folderId: "folders_1", parentId: "folders_2", expectedRevision: 2 } },
      // Unlike createFolder, moveFolder takes an explicit null for the top level.
      { name: "workspaces:moveFolder", args: { folderId: "folders_1", parentId: null, expectedRevision: 3 } },
    ]);
  });

  it("surfaces folder conflicts and cycles with the backend's details", async () => {
    const { client } = fakeConvex({
      "workspaces:renameFolder": new ConvexError({
        code: "VERSION_CONFLICT",
        folderId: "folders_1",
        currentRevision: 4,
        expectedRevision: 3,
      }),
      "workspaces:moveFolder": new ConvexError({ code: "FOLDER_CYCLE", folderId: "folders_1" }),
    });
    const tandem = createConvexApi(client);
    const conflict = await expectApiError(tandem.renameFolder("folders_1", { name: "x", expectedRevision: 3 }));
    expect(conflict.code).toBe("VERSION_CONFLICT");
    expect(conflict.details.currentRevision).toBe(4);
    expect(conflict.details.currentVersion).toBeUndefined();
    const cycle = await expectApiError(tandem.moveFolder("folders_1", { parentId: "folders_2", expectedRevision: 1 }));
    expect(cycle.code).toBe("FOLDER_CYCLE");
  });

  it("refuses a truncated folder list rather than showing part of the tree", async () => {
    const { client } = fakeConvex({ "files:listFolders": { ...FOLDERS, truncated: true } });
    expect((await expectApiError(createConvexApi(client).listFolders("workspaces_1"))).code).toBe("LIST_LIMIT_EXCEEDED");
  });

  it("surfaces move conflicts with the backend's details", async () => {
    const { client } = fakeConvex({
      "files:moveFile": new ConvexError({
        code: "VERSION_CONFLICT",
        fileId: "files_1",
        currentVersion: 4,
        expectedVersion: 3,
        currentContent: "# theirs",
        updatedBy: ALEX,
      }),
    });
    const err = await expectApiError(createConvexApi(client).moveFile("files_1", { parentId: null, expectedVersion: 3 }));
    expect(err.code).toBe("VERSION_CONFLICT");
    expect(err.details.currentVersion).toBe(4);
  });
});

describe("folder error mapping and copy", () => {
  it.each([
    [{ code: "INVALID_PARENT_FOLDER" }, "FOLDER_NOT_FOUND"],
    [{ code: "INVALID_NAME" }, "INVALID_INPUT"],
    [{ code: "FOLDER_CYCLE", folderId: "folders_1" }, "FOLDER_CYCLE"],
    [{ code: "FOLDER_NOT_FOUND", folderId: "folders_1" }, "FOLDER_NOT_FOUND"],
    [{ code: "VERSION_CONFLICT", folderId: "folders_1", currentRevision: 2, expectedRevision: 1 }, "VERSION_CONFLICT"],
    [{ code: "NAME_EXISTS", folderId: "folders_1", name: "Research" }, "NAME_EXISTS"],
    [{ code: "NAME_EXISTS", fileId: "files_1", name: "plan.md", currentVersion: 2 }, "NAME_EXISTS"],
    // A prototype key is not a backend code.
    [{ code: "constructor" }, "UNKNOWN"],
  ])("maps %o to %s", (data, code) => {
    expect(normalizeError(new ConvexError(data)).code).toBe(code);
  });

  it("keeps the name already there on NAME_EXISTS", () => {
    const err = normalizeError(new ConvexError({ code: "NAME_EXISTS", folderId: "folders_1", name: "Research" }));
    expect(err.details.existingName).toBe("Research");
  });

  it("tells a folder-name clash apart from a file-name clash in the destination", () => {
    expect(CREATE_FOLDER_ERROR_COPY.NAME_EXISTS).toMatch(/folder with this name/);
    expect(MOVE_ERROR_COPY.NAME_EXISTS).toMatch(/already has a file with this name/);
    expect(MOVE_ERROR_COPY.VERSION_CONFLICT).toMatch(/changed since/);
    expect(ERROR_COPY.FOLDER_NOT_FOUND.title).toBe("Folder not found");
  });

  it("explains folder rename and move failures in their own words", () => {
    expect(MOVE_FOLDER_ERROR_COPY.FOLDER_CYCLE).toMatch(/can't move a folder into itself or one of its subfolders/);
    expect(ERROR_COPY.FOLDER_CYCLE.description).toMatch(/into itself or one of its subfolders/);
    expect(MOVE_FOLDER_ERROR_COPY.VERSION_CONFLICT).toMatch(/folder changed .* list now shows the latest/);
    expect(RENAME_FOLDER_ERROR_COPY.VERSION_CONFLICT).toMatch(/folder changed .* list now shows the latest/);
    expect(MOVE_FOLDER_ERROR_COPY.NAME_EXISTS).toMatch(/already has a folder with this name/);
    expect(RENAME_FOLDER_ERROR_COPY.NAME_EXISTS).toMatch(/Another folder here/);
    expect(MOVE_FOLDER_ERROR_COPY.FOLDER_NOT_FOUND).toMatch(/no longer exists/);
    expect(RENAME_FOLDER_ERROR_COPY.FOLDER_NOT_FOUND).toMatch(/no longer exists/);
  });
});

describe("folder helpers", () => {
  const folder = (id: string, name: string, parentId: string | null = null): Folder => ({
    id,
    workspaceId: "ws",
    parentId,
    name,
    revision: 1,
    updatedAt: 1,
    updatedBy: human,
  });
  const folders = [folder("b", "beta"), folder("a", "Alpha"), folder("a1", "Child", "a"), folder("a2", "Grand", "a1")];

  it("builds the breadcrumb path top level first, and survives cycles", () => {
    expect(folderPath(folders, findFolder(folders, "a2")).map((f) => f.id)).toEqual(["a", "a1", "a2"]);
    expect(folderPath(folders, null)).toEqual([]);
    const cyclic = [folder("x", "X", "y"), folder("y", "Y", "x")];
    expect(folderPath(cyclic, cyclic[0]!).map((f) => f.id)).toEqual(["y", "x"]);
  });

  it("finds nothing for an unknown or empty folder id", () => {
    expect(findFolder(folders, "nope")).toBeNull();
    expect(findFolder(folders, null)).toBeNull();
  });

  it("lists child folders by name and filters them", () => {
    expect(childFolders(folders, null).map((f) => f.name)).toEqual(["Alpha", "beta"]);
    expect(childFolders(folders, null, "BET").map((f) => f.name)).toEqual(["beta"]);
    expect(childFolders(folders, "a").map((f) => f.name)).toEqual(["Child"]);
  });

  it("flattens the tree depth-first with depths, keeping orphans at the top level", () => {
    const tree = folderTree([...folders, folder("o", "Orphan", "missing")]);
    expect(tree.map(({ folder: f, depth }) => `${depth}:${f.name}`)).toEqual([
      "0:Alpha",
      "1:Child",
      "2:Grand",
      "0:beta",
      "0:Orphan",
    ]);
  });

  it("collects a folder and every folder under it as cycle targets", () => {
    expect([...folderSubtree(folders, "a")].sort()).toEqual(["a", "a1", "a2"]);
    expect([...folderSubtree(folders, "a1")].sort()).toEqual(["a1", "a2"]);
    expect([...folderSubtree(folders, "b")]).toEqual(["b"]);
    const cyclic = [folder("x", "X", "y"), folder("y", "Y", "x")];
    expect([...folderSubtree(cyclic, "x")].sort()).toEqual(["x", "y"]);
  });

  it("validates new folder names", () => {
    expect(parseNewFolderName("  Research ")).toEqual({ ok: true, name: "Research" });
    expect(parseNewFolderName("  ").ok).toBe(false);
    expect(parseNewFolderName("a/b").ok).toBe(false);
    expect(parseNewFolderName("x".repeat(256)).ok).toBe(false);
  });

  it("puts the folder in the URL, and the top level has none", () => {
    expect(folderHref("ws", "a1")).toBe("/w/ws?folder=a1");
    expect(folderHref("ws", null)).toBe("/w/ws");
  });
});
