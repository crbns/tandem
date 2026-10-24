import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { createMockApi, MOCK_WORKSPACE_ID, type MockTandemApi } from "@/lib/api/mock";
import { normalizeError, TandemApiError } from "@/lib/api/errors";
import { describeError, ERROR_COPY } from "@/lib/api/errorCopy";
import type { Actor, FolderSummary } from "@/lib/api/types";
import { crumbItems, describeCounts, folderHref, folderTrail, moveTargets, subtreeCounts } from "@/lib/folders";

const human: Actor = { actorType: "human", userId: "user_demo", userName: "Demo Human" };
const WS = MOCK_WORKSPACE_ID;

async function apiError(promise: Promise<unknown>) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TandemApiError);
  return err as TandemApiError;
}

describe("mock folders (docs/filesystem.md semantics)", () => {
  let api: MockTandemApi;
  const doc = (name: string, parentId?: string | null) =>
    api.createFile(WS, { name, mimeType: "text/markdown", content: `# ${name}`, parentId });

  beforeEach(() => {
    api = createMockApi({ latencyMs: [0, 0], getActor: () => human });
  });

  it("nests folders and lists one directory: folders first by name, paths and breadcrumbs", async () => {
    const a = await api.createFolder(WS, { name: "a" });
    const b = await api.createFolder(WS, { name: "b", parentId: a.id });
    expect(b).toMatchObject({ parentId: a.id, path: "/a/b", revision: 1, updatedBy: human });
    await api.createFolder(WS, { name: "Zeta", parentId: b.id });
    await api.createFolder(WS, { name: "alpha", parentId: b.id });
    const file = await doc("plan.md", b.id);

    const listing = await api.listDirectory(WS, b.id);
    expect(listing.folder).toMatchObject({ id: b.id, name: "b", path: "/a/b" });
    expect(listing.breadcrumbs).toEqual([
      { id: a.id, name: "a" },
      { id: b.id, name: "b" },
    ]);
    expect(listing.folders.map((f) => f.name)).toEqual(["alpha", "Zeta"]);
    expect(listing.files).toEqual([expect.objectContaining({ id: file.id, parentId: b.id, path: "/a/b/plan.md" })]);

    const root = await api.listDirectory(WS);
    expect(root.folder).toBeNull();
    expect(root.breadcrumbs).toEqual([]);
    expect(root.folders.map((f) => f.name)).toEqual(["a", "specs"]);
    expect(root.files.some((f) => f.id === file.id)).toBe(false);
    expect((await api.readFile(file.id)).path).toBe("/a/b/plan.md");
  });

  it("keeps one namespace per folder for files and folders, case-insensitively", async () => {
    const specs = await api.createFolder(WS, { name: "Specs Two" });
    const folderClash = await apiError(doc(" specs   two ", null));
    expect(folderClash.code).toBe("NAME_EXISTS");
    expect(folderClash.details.existing).toEqual({ kind: "folder", id: specs.id, name: "Specs Two" });

    const fileClash = await apiError(api.createFolder(WS, { name: "BRIEF.md" }));
    expect(fileClash.code).toBe("NAME_EXISTS");
    expect(fileClash.details.existing).toMatchObject({ kind: "file", id: "file_brief", name: "brief.md" });

    // The same name is fine in another folder.
    expect(await api.createFolder(WS, { name: "brief.md", parentId: specs.id })).toMatchObject({ path: "/Specs Two/brief.md" });
    const renameClash = await apiError(api.renameFolder(specs.id, "SPECS", specs.revision));
    expect(renameClash.details.existing?.kind).toBe("folder");
  });

  it("rejects names with a slash, dot names and blanks as INVALID_NAME", async () => {
    for (const name of ["a/b", ".", "..", "  ", "x".repeat(256)])
      expect((await apiError(api.createFolder(WS, { name }))).code).toBe("INVALID_NAME");
    expect((await apiError(doc("notes/today.md"))).code).toBe("INVALID_NAME");
  });

  it("creates and uploads into a folder and rejects a missing parent", async () => {
    const folder = await api.createFolder(WS, { name: "assets" });
    const upload = await api.uploadFile(WS, new File(["pdf"], "deck.pdf", { type: "application/pdf" }), { parentId: folder.id });
    expect(upload.pending).toBeFalsy();
    const listing = await api.listDirectory(WS, folder.id);
    expect(listing.files.map((f) => f.path)).toEqual(["/assets/deck.pdf"]);
    expect((await apiError(doc("x.md", "folder_missing"))).code).toBe("FOLDER_NOT_FOUND");
    expect((await apiError(api.listDirectory(WS, "folder_missing"))).code).toBe("FOLDER_NOT_FOUND");
    expect((await apiError(api.listDirectory("ws_other", folder.id))).code).toBe("FORBIDDEN");
  });

  it("moves a file as a new head version, keeping its history and checking the destination", async () => {
    const dest = await api.createFolder(WS, { name: "archive" });
    const watcher = vi.fn();
    api.watchWorkspace(WS, watcher);
    expect(await api.moveFile("file_brief", dest.id, 2)).toEqual({ version: 3 });
    const moved = await api.readFile("file_brief");
    expect(moved).toMatchObject({ parentId: dest.id, version: 3, path: "/archive/brief.md" });
    expect(moved.content).toContain("assistants");
    expect((await api.listRevisions("file_brief")).map((r) => r.version)).toEqual([3, 2, 1]);
    await Promise.resolve();
    expect(watcher).toHaveBeenCalled();

    const stale = await apiError(api.moveFile("file_brief", null, 2));
    expect(stale).toMatchObject({ code: "VERSION_CONFLICT", details: { currentVersion: 3 } });

    await doc("brief.md", null);
    const clash = await apiError(api.moveFile("file_brief", null, 3));
    expect(clash.code).toBe("NAME_EXISTS");
    expect(clash.details.existing?.kind).toBe("file");
    expect((await apiError(api.moveFile("file_brief", "folder_missing", 3))).code).toBe("FOLDER_NOT_FOUND");
  });

  it("moves folders, rejecting cycles, stale revisions and collisions", async () => {
    const a = await api.createFolder(WS, { name: "a" });
    const b = await api.createFolder(WS, { name: "b", parentId: a.id });
    const c = await api.createFolder(WS, { name: "c", parentId: b.id });
    await doc("deep.md", c.id);

    expect((await apiError(api.moveFolder(a.id, a.id, 1))).code).toBe("INVALID_MOVE");
    expect((await apiError(api.moveFolder(a.id, c.id, 1))).code).toBe("INVALID_MOVE");

    const moved = await api.moveFolder(b.id, null, 1);
    expect(moved).toMatchObject({ parentId: null, path: "/b", revision: 2 });
    // Descendants' paths follow the move.
    expect((await api.listDirectory(WS, c.id)).files[0]?.path).toBe("/b/c/deep.md");
    expect((await api.listDirectory(WS, c.id)).breadcrumbs.map((x) => x.name)).toEqual(["b", "c"]);

    const stale = await apiError(api.moveFolder(b.id, a.id, 1));
    expect(stale).toMatchObject({ code: "VERSION_CONFLICT", details: { currentRevision: 2 } });

    await api.createFolder(WS, { name: "B", parentId: a.id });
    expect((await apiError(api.moveFolder(b.id, a.id, 2))).code).toBe("NAME_EXISTS");
  });

  it("caps nesting at 32 folders, for creates and for moves", async () => {
    let parentId: string | null = null;
    const chain: FolderSummary[] = [];
    for (let depth = 1; depth <= 32; depth++) {
      const folder: FolderSummary = await api.createFolder(WS, { name: `d${depth}`, parentId });
      chain.push(folder);
      parentId = folder.id;
    }
    expect((await apiError(api.createFolder(WS, { name: "d33", parentId }))).code).toBe("FOLDER_TOO_DEEP");

    // A two-level subtree fits under depth 30 but not under depth 31.
    const top = await api.createFolder(WS, { name: "top" });
    await api.createFolder(WS, { name: "child", parentId: top.id });
    expect((await apiError(api.moveFolder(top.id, chain[30]!.id, 1))).code).toBe("FOLDER_TOO_DEEP");
    expect(await api.moveFolder(top.id, chain[29]!.id, 1)).toMatchObject({ parentId: chain[29]!.id });
  });

  it("renames a folder and its contents' paths follow", async () => {
    const folder = await api.createFolder(WS, { name: "drafts" });
    await doc("idea.md", folder.id);
    const renamed = await api.renameFolder(folder.id, "  Final ", 1);
    expect(renamed).toMatchObject({ name: "Final", path: "/Final", revision: 2 });
    expect((await api.listDirectory(WS, folder.id)).files[0]?.path).toBe("/Final/idea.md");
    expect((await apiError(api.renameFolder(folder.id, "x", 1))).code).toBe("VERSION_CONFLICT");
  });

  it("deletes a folder recursively, keeps history out of listings and releases names", async () => {
    const a = await api.createFolder(WS, { name: "a" });
    const b = await api.createFolder(WS, { name: "b", parentId: a.id });
    const top = await doc("top.md", a.id);
    const inner = await doc("inner.md", b.id);
    const watcher = vi.fn();
    api.watchWorkspace(WS, watcher);

    expect(await api.deleteFolder(a.id, 1)).toEqual({ deletedFiles: 2, deletedFolders: 2 });
    await Promise.resolve();
    expect(watcher).toHaveBeenCalled();
    for (const id of [top.id, inner.id]) expect((await apiError(api.readFile(id))).code).toBe("FILE_NOT_FOUND");
    expect((await apiError(api.listDirectory(WS, b.id))).code).toBe("FOLDER_NOT_FOUND");
    expect((await api.listFolderTree(WS)).map((f) => f.path)).toEqual(["/specs"]);
    expect((await api.listFiles(WS)).some((f) => f.id === top.id)).toBe(false);
    // The name is free again.
    expect(await api.createFolder(WS, { name: "A" })).toMatchObject({ path: "/A" });
  });

  it("refuses to delete more than 500 items at once and writes nothing", async () => {
    const big = await api.createFolder(WS, { name: "big" });
    for (let i = 0; i < 500; i++) await doc(`f${i}.md`, big.id);
    const err = await apiError(api.deleteFolder(big.id, 1));
    expect(err.code).toBe("FOLDER_TOO_LARGE");
    expect((await api.listDirectory(WS, big.id)).files).toHaveLength(500);
  });

  it("lists the folder tree in path order", async () => {
    const z = await api.createFolder(WS, { name: "z" });
    await api.createFolder(WS, { name: "inner", parentId: z.id });
    await api.createFolder(WS, { name: "a" });
    expect((await api.listFolderTree(WS)).map((f) => f.path)).toEqual(["/a", "/specs", "/z", "/z/inner"]);
  });
});

const folder = (id: string, parentId: string | null, path: string): FolderSummary => ({
  id,
  workspaceId: WS,
  parentId,
  name: path.split("/").at(-1)!,
  path,
  revision: 1,
  updatedAt: 0,
  updatedBy: human,
});
const TREE = [
  folder("f_b", "f_a", "/a/b"),
  folder("f_a", null, "/a"),
  folder("f_c", "f_b", "/a/b/c"),
  folder("f_z", null, "/z"),
];

describe("folder helpers", () => {
  it("keeps the current folder in the URL and leaves the root bare", () => {
    expect(folderHref("ws", null)).toBe("/w/ws");
    expect(folderHref("ws", "f a")).toBe("/w/ws?folder=f%20a");
  });

  it("builds Workspace root > a > b breadcrumbs, appending the current folder when missing", () => {
    const b = folder("f_b", "f_a", "/a/b");
    const fromParentOnly = folderTrail({ folder: b, breadcrumbs: [{ id: "f_a", name: "a" }] });
    const inclusive = folderTrail({ folder: b, breadcrumbs: [{ id: "f_a", name: "a" }, { id: "f_b", name: "b" }] });
    expect(fromParentOnly).toEqual(inclusive);
    expect(crumbItems("ws", inclusive)).toEqual([
      { label: "Workspace root", href: "/w/ws" },
      { label: "a", href: "/w/ws?folder=f_a" },
      { label: "b", href: "/w/ws?folder=f_b" },
    ]);
    expect(crumbItems("ws", folderTrail({ folder: null, breadcrumbs: [] }))).toEqual([{ label: "Workspace root", href: "/w/ws" }]);
  });

  it("offers every folder as a move target except the current one, and a folder's own subtree", () => {
    const forFile = moveTargets(TREE, { kind: "file", id: "file_1", parentId: "f_b" });
    expect(forFile.map((t) => [t.path, t.depth, t.reason ?? null])).toEqual([
      ["/", 0, null],
      ["/a", 1, null],
      ["/a/b", 2, "current"],
      ["/a/b/c", 3, null],
      ["/z", 1, null],
    ]);

    const forFolder = moveTargets(TREE, { kind: "folder", id: "f_b", parentId: "f_a" });
    expect(forFolder.filter((t) => t.disabled).map((t) => [t.path, t.reason])).toEqual([
      ["/a", "current"],
      ["/a/b", "inside"],
      ["/a/b/c", "inside"],
    ]);
    expect(moveTargets(TREE, { kind: "folder", id: "f_z", parentId: null })[0]).toMatchObject({ id: null, disabled: true, reason: "current" });
  });

  it("counts what a folder delete removes", () => {
    const files = [{ parentId: "f_c" }, { parentId: "f_a" }, { parentId: "f_z" }, { parentId: null }];
    expect(subtreeCounts("f_a", TREE, files)).toEqual({ folders: 3, files: 2 });
    expect(subtreeCounts("f_z", TREE, files)).toEqual({ folders: 1, files: 1 });
    expect(describeCounts({ folders: 1, files: 0 })).toBe("1 folder and 0 files");
    expect(describeCounts({ folders: 3, files: 1 })).toBe("3 folders and 1 file");
  });
});

describe("folder error codes", () => {
  it.each(["INVALID_NAME", "INVALID_MOVE", "FOLDER_TOO_DEEP", "FOLDER_TOO_LARGE", "FOLDER_NOT_FOUND"] as const)(
    "passes the backend's %s through with its own copy",
    (code) => {
      expect(normalizeError(new ConvexError({ code })).code).toBe(code);
      expect(ERROR_COPY[code].description).not.toBe(ERROR_COPY.UNKNOWN.description);
    },
  );

  it("says whether a file or a folder already holds a name", () => {
    const folderClash = normalizeError(new ConvexError({ code: "NAME_EXISTS", kind: "folder", folderId: "f1", name: "specs" }));
    expect(folderClash.details.existing).toEqual({ kind: "folder", id: "f1", name: "specs" });
    expect(describeError(folderClash)).toBe("A folder named “specs” already exists here. Names ignore case and extra spaces; pick another.");

    const fileClash = normalizeError(new ConvexError({ code: "NAME_EXISTS", kind: "file", fileId: "x", name: "a.md", currentVersion: 4 }));
    expect(fileClash.details).toMatchObject({ currentVersion: 4, existing: { kind: "file", id: "x" } });
    expect(describeError(fileClash)).toMatch(/^A file named “a.md”/);

    // Without a kind (older backends) the overrides still apply.
    expect(describeError(new TandemApiError("NAME_EXISTS"), { NAME_EXISTS: "custom" })).toBe("custom");
  });

  it("reads a folder conflict's current revision", () => {
    const err = normalizeError(new ConvexError({ code: "VERSION_CONFLICT", currentRevision: 7 }));
    expect(err).toMatchObject({ code: "VERSION_CONFLICT", details: { currentRevision: 7 } });
  });
});
