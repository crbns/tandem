import { describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import type { ConvexReactClient } from "convex/react";
import { getFunctionName, type FunctionReference, type FunctionReturnType } from "convex/server";
import type { api } from "@repo/backend/convex/_generated/api.js";
import type { Id } from "@repo/backend/convex/_generated/dataModel.js";
import { createConvexApi } from "@/lib/api/convex";
import { normalizeError, type TandemApiError } from "@/lib/api/errors";
import { CREATE_ERROR_COPY, describeError, FOLDER_ERROR_COPY } from "@/lib/api/errorCopy";
import { performSave } from "@/lib/editor/performSave";

// Fixtures are typed from the backend's generated function types, so a backend
// shape change fails `check-types` here instead of silently passing.
type BackendFile = FunctionReturnType<typeof api.files.readFile>["file"];
type BackendFilesPage = FunctionReturnType<typeof api.files.listFiles>;
type BackendActor = BackendFile["updatedBy"];
type BackendContext = NonNullable<FunctionReturnType<typeof api.workspaces.getWorkspaceContext>>;
type BackendWorkspaces = FunctionReturnType<typeof api.workspaces.listWorkspaces>;
type BackendVersions = FunctionReturnType<typeof api.files.getFileVersions>;
type BackendRevision = FunctionReturnType<typeof api.files.getFileRevision>;

const ALEX_ID = "users_alex" as Id<"users">;
const ALEX: BackendActor = { type: "human", userId: ALEX_ID, label: "Alex" };
const CLAUDE: BackendActor = {
  type: "agent",
  userId: ALEX_ID,
  agentConnectionId: "agent_connections_1" as Id<"agent_connections">,
  label: "Claude",
  client: "claude",
  userName: "Alex",
};

const FILE: BackendFile = {
  id: "files_1" as Id<"files">,
  workspaceId: "workspaces_1" as Id<"workspaces">,
  parentId: null,
  name: "plan.md",
  mimeType: "text/markdown",
  version: 3,
  updatedAt: 1_700_000_000_000,
  updatedBy: CLAUDE,
};

const FILES_PAGE: BackendFilesPage = {
  page: [FILE],
  isDone: true,
  continueCursor: "",
};

const WORKSPACES: BackendWorkspaces = [
  { id: "workspaces_1" as Id<"workspaces">, name: "Cal Hacks", role: "owner", updatedAt: 1 },
];
const VERSIONS: BackendVersions = [
  { id: "r1" as Id<"file_revisions">, version: 1, actor: ALEX, createdAt: 1 },
];
const REVISION: BackendRevision = {
  id: "r1" as Id<"file_revisions">,
  version: 1,
  content: "a",
  actor: ALEX,
  createdAt: 1,
};

const entry = (text: string, updatedAt = 1_700_000_000_000): BackendContext["constraints"][number] => ({
  text,
  id: `entry_${text}`, status: "active", resolvedBy: null, resolvedAt: null, supersededBy: null,
  sourceFileIds: [],
  updatedAt,
  updatedBy: ALEX,
});

const EMPTY_CONTEXT: BackendContext = {
  updatedBy: ALEX,
  goal: null,
  scope: null,
  constraints: [],
  decisions: [],
  ownership: [],
  openQuestions: [],
  revision: 1,
  updatedAt: 1_700_000_000_000,
};

/** A ConvexReactClient stand-in that answers by function name and records calls. */
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

describe("createConvexApi", () => {
  it("forwards rename and delete with the expected version", async () => {
    const { client, calls } = fakeConvex({
      "files:renameFile": { ...FILE, name: "renamed.md", version: 4 },
      "files:deleteFile": null,
    });
    const tandem = createConvexApi(client);
    expect(await tandem.renameFile("files_1", "renamed.md", 3)).toEqual({ version: 4 });
    await tandem.deleteFile("files_1", 4);
    expect(calls).toEqual([
      { name: "files:renameFile", args: { fileId: "files_1", name: "renamed.md", expectedVersion: 3 } },
      { name: "files:deleteFile", args: { fileId: "files_1", expectedVersion: 4 } },
    ]);
  });

  it("calls the backend's function names with exact args and maps what comes back", async () => {
    const { client, calls } = fakeConvex({
      "workspaces:listWorkspaces": WORKSPACES,
      "workspaces:createWorkspace": "workspaces_2",
      "files:listFiles": FILES_PAGE,
      "files:readFile": { file: FILE, content: "x" },
      "files:createDocument": { ...FILE, id: "files_2", version: 1 },
      "files:updateDocument": { ...FILE, version: 4 },
      "files:getFileVersions": VERSIONS,
      "files:getFileRevision": REVISION,
      "workspaces:getWorkspaceContext": { ...EMPTY_CONTEXT, goal: entry("Ship it") },
    });
    const tandem = createConvexApi(client);

    expect(await tandem.listWorkspaces()).toEqual([{ id: "workspaces_1", name: "Cal Hacks", role: "owner" }]);
    expect(await tandem.createWorkspace("New")).toBe("workspaces_2");
    expect((await tandem.listFiles("workspaces_1"))[0]?.updatedBy.agentName).toBe("Claude");
    expect((await tandem.readFile("files_1")).content).toBe("x");
    expect(
      await tandem.createFile("workspaces_1", { name: "n.md", mimeType: "text/markdown", content: "" }),
    ).toEqual({ id: "files_2", version: 1 });
    expect(await tandem.updateFileContent("files_1", { expectedVersion: 3, content: "y" })).toEqual({ version: 4 });
    expect((await tandem.listRevisions("files_1"))[0]?.userName).toBe("Alex");
    expect((await tandem.getRevision("files_1", 1))?.content).toBe("a");
    expect((await tandem.getContext("workspaces_1"))?.goal).toBe("Ship it");

    // Exact args: Convex rejects unknown keys, so an extra one would fail for real.
    expect(calls).toEqual([
      { name: "workspaces:listWorkspaces", args: {} },
      { name: "workspaces:createWorkspace", args: { name: "New" } },
      {
        name: "files:listFiles",
        args: { workspaceId: "workspaces_1", paginationOpts: { numItems: 100, cursor: null } },
      },
      { name: "files:readFile", args: { fileId: "files_1" } },
      {
        name: "files:createDocument",
        args: { workspaceId: "workspaces_1", name: "n.md", mimeType: "text/markdown", content: "" },
      },
      { name: "files:updateDocument", args: { fileId: "files_1", expectedVersion: 3, content: "y" } },
      // The backend's maximum; its default of 20 would cut history short.
      { name: "files:getFileVersions", args: { fileId: "files_1", limit: 100 } },
      { name: "files:getFileRevision", args: { fileId: "files_1", version: 1 } },
      { name: "workspaces:getWorkspaceContext", args: { workspaceId: "workspaces_1" } },
    ]);
  });

  it("keeps superseded decisions out of compact context summaries", async () => {
    const { client } = fakeConvex({ "workspaces:getWorkspaceContext": {
      ...EMPTY_CONTEXT, goal: entry("Ship"), decisions: [
        { ...entry("Old decision"), status: "superseded", supersededBy: "replacement" },
        { ...entry("Current decision"), id: "replacement" },
      ],
    } });
    expect((await createConvexApi(client).getContext("workspaces_1"))?.decisions).toEqual(["Current decision"]);
  });

  it("maps a file in full, naming both the person and the assistant on agent writes", async () => {
    const { client } = fakeConvex({
      "files:readFile": { file: { ...FILE, parentId: "folders_1" }, content: "x" },
      "files:listFiles": FILES_PAGE,
    });
    const tandem = createConvexApi(client);
    const summary = {
      id: "files_1",
      workspaceId: "workspaces_1",
      parentId: null,
      name: "plan.md",
      mimeType: "text/markdown",
      version: 3,
      updatedAt: 1_700_000_000_000,
      updatedBy: {
        actorType: "agent",
        userId: "users_alex",
        userName: "Alex",
        agentName: "Claude",
        agentClient: "claude",
      },
    };
    expect(await tandem.listFiles("workspaces_1")).toEqual([summary]);
    // Any member may call updateDocument, so a readable file is editable.
    expect(await tandem.readFile("files_1")).toEqual({
      ...summary,
      parentId: "folders_1",
      content: "x",
      permissions: { canEdit: true },
    });
  });

  it("renders a system actor by its label, never as an agent", async () => {
    const { client } = fakeConvex({
      "files:readFile": { file: { ...FILE, updatedBy: { type: "system", label: "Tandem" } }, content: "x" },
    });
    const { updatedBy } = await createConvexApi(client).readFile("files_1");
    expect(updatedBy).toMatchObject({ actorType: "human", userId: "", userName: "Tandem" });
    expect(updatedBy.agentName).toBeUndefined();
  });

  it("leaves revision content to getRevision, which is null for a missing version", async () => {
    const { client } = fakeConvex({ "files:getFileVersions": VERSIONS, "files:getFileRevision": null });
    const tandem = createConvexApi(client);
    expect((await tandem.listRevisions("files_1"))[0]?.content).toBeUndefined();
    expect(await tandem.getRevision("files_1", 9)).toBeNull();
  });

  it("is null without an approved goal, and credits the approver when there is one", async () => {
    const empty = fakeConvex({ "workspaces:getWorkspaceContext": EMPTY_CONTEXT });
    expect(await createConvexApi(empty.client).getContext("workspaces_1")).toBeNull();
    const none = fakeConvex({ "workspaces:getWorkspaceContext": null });
    expect(await createConvexApi(none.client).getContext("workspaces_1")).toBeNull();

    const approved = fakeConvex({
      "workspaces:getWorkspaceContext": {
        ...EMPTY_CONTEXT,
        goal: entry("Ship the demo", 5),
        constraints: [entry("No CRDT")],
        decisions: [entry("Use Convex")],
        revision: 4,
      },
    });
    expect(await createConvexApi(approved.client).getContext("workspaces_1")).toEqual({
      goal: "Ship the demo",
      scope: "",
      constraints: ["No CRDT"],
      decisions: ["Use Convex"],
      version: 4,
      approvedBy: { actorType: "human", userId: "users_alex", userName: "Alex" },
      approvedAt: 5,
    });
  });

  it("opens the conflict screen from the backend's VERSION_CONFLICT without a reread", async () => {
    const { client, calls } = fakeConvex({
      "files:updateDocument": new ConvexError({
        code: "VERSION_CONFLICT",
        currentVersion: 4,
        currentContent: "# theirs",
        updatedBy: { type: "agent", userId: "users_alex", label: "Claude", client: "claude", userName: "Alex" },
      }),
    });
    expect(await performSave(createConvexApi(client), "files_1", 3, "# mine")).toEqual({
      type: "SAVE_CONFLICT",
      theirs: {
        version: 4,
        content: "# theirs",
        updatedBy: { actorType: "agent", userId: "users_alex", userName: "Alex", agentName: "Claude", agentClient: "claude" },
      },
    });
    expect(calls.map((c) => c.name)).toEqual(["files:updateDocument"]);
  });

  it("rereads the file when a conflict arrives without content (binary file)", async () => {
    const { client } = fakeConvex({
      "files:updateDocument": new ConvexError({ code: "VERSION_CONFLICT", currentVersion: 4, currentContent: null }),
      "files:readFile": { file: { ...FILE, version: 4 }, content: "# theirs" },
    });
    expect(await performSave(createConvexApi(client), "files_1", 3, "# mine")).toMatchObject({
      type: "SAVE_CONFLICT",
      theirs: { version: 4, content: "# theirs" },
    });
  });

  it.each([
    ["FORBIDDEN", "FORBIDDEN"],
    ["FILE_NOT_FOUND", "FILE_NOT_FOUND"],
    ["UNAUTHENTICATED", "UNAUTHENTICATED"],
    ["INVALID_NAME", "INVALID_NAME"],
    ["INVALID_PARENT_FOLDER", "FOLDER_NOT_FOUND"],
    ["WORKSPACE_NOT_FOUND", "FORBIDDEN"],
    ["CONTEXT_NOT_INITIALIZED", "UNKNOWN"],
  ])("maps the backend's ConvexError %s to %s", (backendCode, code) => {
    expect(normalizeError(new ConvexError({ code: backendCode })).code).toBe(code);
  });
});

describe("restoreRevision adapter (#26)", () => {
  it("passes the selected and expected versions to the mutation", async () => {
    const { client, calls } = fakeConvex({ "files:restoreRevision": { ...FILE, version: 4, updatedBy: ALEX } });
    expect(await createConvexApi(client).restoreRevision("files_1", 1, 3)).toEqual({ version: 4 });
    expect(calls).toEqual([{ name: "files:restoreRevision", args: { fileId: "files_1", version: 1, expectedVersion: 3 } }]);
  });

  it("preserves VERSION_CONFLICT details and never retries a stale restore", async () => {
    const { client, calls } = fakeConvex({ "files:restoreRevision": new ConvexError({ code: "VERSION_CONFLICT", currentVersion: 4, currentContent: "newer" }) });
    await expect(createConvexApi(client).restoreRevision("files_1", 1, 3)).rejects.toMatchObject({ code: "VERSION_CONFLICT", details: { currentVersion: 4, currentContent: "newer" } });
    expect(calls).toHaveLength(1);
  });
});

type BackendListing = FunctionReturnType<typeof api.folders.listDirectory>;
type BackendFolderRow = BackendListing["folders"][number];

describe("folder adapter (docs/filesystem.md Dashboard API)", () => {
  const folderRow = (id: string, parentId: string | null, path: string, revision = 1): BackendFolderRow => ({
    id: id as Id<"folders">,
    workspaceId: "workspaces_1" as Id<"workspaces">,
    parentId: parentId as Id<"folders"> | null,
    name: path.split("/").at(-1)!,
    path,
    revision,
    updatedAt: 1,
    updatedBy: ALEX,
  });
  const SPECS = folderRow("folders_1", null, "/specs");
  const API = folderRow("folders_2", "folders_1", "/specs/api");
  const LISTING: BackendListing = {
    folder: SPECS,
    breadcrumbs: [{ id: SPECS.id, name: "specs" }],
    folders: [API],
    files: [{ ...FILE, parentId: SPECS.id, path: "/specs/plan.md" }],
  };

  it("calls api.folders.* and files.moveFile with exact args and maps rows", async () => {
    const { client, calls } = fakeConvex({
      "folders:listDirectory": LISTING,
      "folders:listFolderTree": [SPECS, API],
      "folders:createFolder": API,
      "folders:renameFolder": { ...API, name: "v2", path: "/specs/v2", revision: 2 },
      "folders:moveFolder": { ...API, parentId: null, path: "/api", revision: 2 },
      "folders:deleteFolder": { deletedFiles: 3, deletedFolders: 2 },
      "files:moveFile": { ...FILE, version: 4 },
      "files:createDocument": { ...FILE, id: "files_2", version: 1 },
    });
    const tandem = createConvexApi(client);

    const listing = await tandem.listDirectory("workspaces_1", "folders_1");
    expect(listing.folder).toMatchObject({ id: "folders_1", parentId: null, path: "/specs", revision: 1 });
    expect(listing.breadcrumbs).toEqual([{ id: "folders_1", name: "specs" }]);
    expect(listing.folders[0]).toMatchObject({ id: "folders_2", parentId: "folders_1", updatedBy: { actorType: "human", userName: "Alex" } });
    expect(listing.files[0]).toMatchObject({ id: "files_1", parentId: "folders_1", path: "/specs/plan.md" });
    await tandem.listDirectory("workspaces_1", null);
    expect((await tandem.listFolderTree("workspaces_1")).map((f) => f.path)).toEqual(["/specs", "/specs/api"]);
    expect(await tandem.createFolder("workspaces_1", { name: "api", parentId: "folders_1" })).toMatchObject({ path: "/specs/api" });
    await tandem.createFolder("workspaces_1", { name: "top", parentId: null });
    expect(await tandem.renameFolder("folders_2", "v2", 1)).toMatchObject({ name: "v2", revision: 2 });
    expect(await tandem.moveFolder("folders_2", null, 2)).toMatchObject({ parentId: null, path: "/api" });
    expect(await tandem.deleteFolder("folders_1", 1)).toEqual({ deletedFiles: 3, deletedFolders: 2 });
    expect(await tandem.moveFile("files_1", "folders_1", 3)).toEqual({ version: 4 });
    await tandem.createFile("workspaces_1", { name: "n.md", mimeType: "text/markdown", content: "", parentId: "folders_1" });

    expect(calls).toEqual([
      { name: "folders:listDirectory", args: { workspaceId: "workspaces_1", folderId: "folders_1" } },
      { name: "folders:listDirectory", args: { workspaceId: "workspaces_1" } },
      { name: "folders:listFolderTree", args: { workspaceId: "workspaces_1" } },
      { name: "folders:createFolder", args: { workspaceId: "workspaces_1", name: "api", parentId: "folders_1" } },
      { name: "folders:createFolder", args: { workspaceId: "workspaces_1", name: "top" } },
      { name: "folders:renameFolder", args: { folderId: "folders_2", name: "v2", expectedRevision: 1 } },
      { name: "folders:moveFolder", args: { folderId: "folders_2", parentId: null, expectedRevision: 2 } },
      { name: "folders:deleteFolder", args: { folderId: "folders_1", expectedRevision: 1 } },
      { name: "files:moveFile", args: { fileId: "files_1", parentId: "folders_1", expectedVersion: 3 } },
      { name: "files:createDocument", args: { workspaceId: "workspaces_1", name: "n.md", mimeType: "text/markdown", content: "", parentId: "folders_1" } },
    ]);
  });

  it("reports a missing destination or parent folder as FOLDER_NOT_FOUND, like the mock", async () => {
    const gone = new ConvexError({ code: "INVALID_PARENT_FOLDER", folderId: "folders_9" });
    const { client } = fakeConvex({
      "folders:moveFolder": gone,
      "folders:createFolder": gone,
      "files:moveFile": gone,
      "files:createDocument": gone,
    });
    const tandem = createConvexApi(client);
    const errors = await Promise.all([
      tandem.moveFolder("folders_2", "folders_9", 1),
      tandem.createFolder("workspaces_1", { name: "x", parentId: "folders_9" }),
      tandem.moveFile("files_1", "folders_9", 3),
      tandem.createFile("workspaces_1", { name: "n.md", mimeType: "text/markdown", content: "", parentId: "folders_9" }),
    ].map((p) => p.then(() => null, (e: TandemApiError) => e)));
    expect(errors.map((e) => e?.code)).toEqual(["FOLDER_NOT_FOUND", "FOLDER_NOT_FOUND", "FOLDER_NOT_FOUND", "FOLDER_NOT_FOUND"]);
    expect(describeError(errors[0]!, FOLDER_ERROR_COPY)).toBe(FOLDER_ERROR_COPY.FOLDER_NOT_FOUND);
    expect(describeError(errors[3]!, CREATE_ERROR_COPY)).toBe(CREATE_ERROR_COPY.FOLDER_NOT_FOUND);
  });

  it("treats a ?folder= id that fails argument validation as FOLDER_NOT_FOUND", async () => {
    const invalid = new Error('ArgumentValidationError: Value does not match validator.\nPath: .folderId\nValidator: v.id("folders")');
    const { client } = fakeConvex({ "folders:listDirectory": invalid });
    const tandem = createConvexApi(client);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(tandem.listDirectory("workspaces_1", "files_1")).rejects.toMatchObject({ code: "FOLDER_NOT_FOUND" });
    await expect(tandem.listDirectory("workspaces_1", "not-an-id")).rejects.toMatchObject({ code: "FOLDER_NOT_FOUND" });
    // The root listing has no folder id to blame, and other errors keep their codes.
    await expect(tandem.listDirectory("workspaces_1", null)).rejects.toMatchObject({ code: "UNKNOWN" });
    const offline = fakeConvex({ "folders:listDirectory": new Error("Failed to fetch") });
    await expect(createConvexApi(offline.client).listDirectory("workspaces_1", "folders_1")).rejects.toMatchObject({ code: "NETWORK" });
    vi.restoreAllMocks();
  });

  it("surfaces folder errors with their own codes and details", async () => {
    const { client } = fakeConvex({
      "folders:moveFolder": new ConvexError({ code: "INVALID_MOVE" }),
      "folders:renameFolder": new ConvexError({ code: "NAME_EXISTS", kind: "file", fileId: "files_1", name: "plan.md", currentVersion: 3 }),
      "folders:deleteFolder": new ConvexError({ code: "VERSION_CONFLICT", currentRevision: 5 }),
      "folders:listDirectory": new ConvexError({ code: "FOLDER_NOT_FOUND", folderId: "folders_9" }),
    });
    const tandem = createConvexApi(client);
    await expect(tandem.moveFolder("folders_1", "folders_2", 1)).rejects.toMatchObject({ code: "INVALID_MOVE" });
    await expect(tandem.renameFolder("folders_1", "plan.md", 1)).rejects.toMatchObject({
      code: "NAME_EXISTS", details: { existing: { kind: "file", id: "files_1", name: "plan.md" } },
    });
    await expect(tandem.deleteFolder("folders_1", 1)).rejects.toMatchObject({ code: "VERSION_CONFLICT", details: { currentRevision: 5 } });
    await expect(tandem.listDirectory("workspaces_1", "folders_9")).rejects.toMatchObject({ code: "FOLDER_NOT_FOUND" });
  });
});
