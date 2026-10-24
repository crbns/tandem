/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  MAX_FOLDER_DEPTH,
  MAX_INDEXED_FOLDERS,
  ensureFolderPathCore,
  filePath,
  folderPath,
  loadFolderIndex,
  resolvePath,
  splitPath,
} from "./lib/fs";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) => ctx.db.insert("users", { name: "Owner" }));
  const owner = t.withIdentity({ subject: `${userId}|session` });
  const workspaceId = await owner.mutation(api.workspaces.createWorkspace, {
    name: "Files",
  });
  const actor = { type: "human" as const, userId, label: "Owner" };
  const mkdir = (name: string, parentId?: Id<"folders">) =>
    owner.mutation(api.folders.createFolder, { workspaceId, parentId, name });
  const touch = (name: string, parentId?: Id<"folders">, content = "") =>
    owner.mutation(api.files.createDocument, {
      workspaceId,
      parentId,
      name,
      mimeType: "text/markdown",
      content,
    });
  const events = (kind: string) =>
    t.run((ctx) =>
      ctx.db
        .query("workspace_events")
        .withIndex("by_workspace_and_seq", (q) => q.eq("workspaceId", workspaceId))
        .collect()
        .then((rows) => rows.filter((e) => e.kind === kind)),
    );
  return { t, owner, workspaceId, actor, mkdir, touch, events };
}

describe("nested folders", () => {
  it("creates nested folders and files with paths, attribution and events", async () => {
    const { t, owner, workspaceId, mkdir, touch, events } = await setup();
    const specs = await mkdir(" specs ");
    expect(specs).toMatchObject({ name: "specs", path: "/specs", parentId: null, revision: 1 });
    const api_ = await mkdir("api", specs.id);
    expect(api_).toMatchObject({ path: "/specs/api", parentId: specs.id });
    const file = await touch("endpoints.md", api_.id, "GET /");
    expect(file.parentId).toBe(api_.id);
    const stored = await t.run((ctx) => ctx.db.get(api_.id));
    expect(stored).toMatchObject({ nameKey: "api", createdBy: { label: "Owner" } });
    expect((await events("folder.created")).map((e) => e.entityId)).toEqual([specs.id, api_.id]);
    await t.run(async (ctx) => {
      const doc = (await ctx.db.get(file.id))!;
      expect(await filePath(ctx, doc)).toBe("/specs/api/endpoints.md");
      expect(await folderPath(ctx, api_.id)).toBe("/specs/api");
      expect(await folderPath(ctx)).toBe("/");
      const index = await loadFolderIndex(ctx, workspaceId);
      expect(index.folderPath(api_.id)).toBe("/specs/api");
      expect(index.filePath(doc)).toBe("/specs/api/endpoints.md");
    });
    // The legacy wrapper still returns an id.
    const legacyId = await owner.mutation(api.workspaces.createFolder, {
      workspaceId,
      parentId: specs.id,
      name: "legacy",
    });
    expect(await t.run((ctx) => folderPath(ctx, legacyId))).toBe("/specs/legacy");
  });

  it("ensureFolderPathCore is mkdir -p and idempotent", async () => {
    const { t, workspaceId, actor, touch } = await setup();
    const first = await t.run((ctx) =>
      ensureFolderPathCore(ctx, { workspaceId, path: "a/b/c/", actor }),
    );
    expect(first.created).toBe(true);
    expect(first.folder.name).toBe("c");
    const again = await t.run((ctx) =>
      ensureFolderPathCore(ctx, { workspaceId, path: "/A/b/C", actor }),
    );
    expect(again).toMatchObject({ created: false, folder: { _id: first.folder._id } });
    const deeper = await t.run((ctx) =>
      ensureFolderPathCore(ctx, { workspaceId, path: "/a/b/d", actor }),
    );
    expect(deeper.created).toBe(true);
    expect(await t.run((ctx) => folderPath(ctx, deeper.folder._id))).toBe("/a/b/d");
    const count = await t.run(async (ctx) =>
      (await ctx.db.query("folders").collect()).length,
    );
    expect(count).toBe(4);
    await touch("notes.md");
    await expect(
      t.run((ctx) => ensureFolderPathCore(ctx, { workspaceId, path: "/notes.md/x", actor })),
    ).rejects.toThrow(/NAME_EXISTS[\s\S]*"kind":"file"/);
    await expect(
      t.run((ctx) => ensureFolderPathCore(ctx, { workspaceId, path: "/a//b", actor })),
    ).rejects.toThrow("INVALID_PATH");
    await expect(
      t.run((ctx) => ensureFolderPathCore(ctx, { workspaceId, path: "/", actor })),
    ).rejects.toThrow("INVALID_PATH");
  });

  it("shares one namespace between files and folders, both ways", async () => {
    const { mkdir, touch } = await setup();
    const docs = await mkdir("Docs");
    await touch("readme.md");
    await expect(touch("DOCS")).rejects.toThrow(/NAME_EXISTS[\s\S]*"kind":"folder"/);
    await expect(mkdir("README.md")).rejects.toThrow(/NAME_EXISTS[\s\S]*"kind":"file"/);
    await expect(mkdir(" docs ")).rejects.toThrow(/NAME_EXISTS[\s\S]*"kind":"folder"/);
    // Same name in another folder is fine.
    await expect(touch("readme.md", docs.id)).resolves.toMatchObject({ parentId: docs.id });
    await expect(mkdir("docs", docs.id)).resolves.toMatchObject({ path: "/Docs/docs" });
  });

  it("keys legacy folders without nameKey by their name", async () => {
    const { t, workspaceId, actor, mkdir, touch } = await setup();
    const legacyId = await t.run((ctx) =>
      ctx.db.insert("folders", {
        workspaceId,
        name: "Old Stuff",
        createdBy: actor,
        updatedBy: actor,
        revision: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await expect(mkdir("old  stuff")).rejects.toThrow(/NAME_EXISTS[\s\S]*"kind":"folder"/);
    await expect(touch("OLD STUFF")).rejects.toThrow(/NAME_EXISTS[\s\S]*"kind":"folder"/);
    expect(
      await t.run((ctx) => resolvePath(ctx, workspaceId, "/old stuff")),
    ).toMatchObject({ kind: "folder", folder: { _id: legacyId } });
  });

  it("finds legacy folders past many deleted siblings", async () => {
    const { t, workspaceId, actor, mkdir } = await setup();
    const row = { workspaceId, createdBy: actor, updatedBy: actor, revision: 1, createdAt: 1, updatedAt: 1 };
    const legacyId = await t.run(async (ctx) => {
      // Deleted folders release their nameKey, like legacy rows.
      for (let i = 0; i < 500; i++)
        await ctx.db.insert("folders", { ...row, name: `dead${i}`, deletedAt: 1 });
      return await ctx.db.insert("folders", { ...row, name: "Legacy" });
    });
    expect(
      await t.run((ctx) => resolvePath(ctx, workspaceId, "/Legacy")),
    ).toMatchObject({ kind: "folder", folder: { _id: legacyId } });
    await expect(mkdir("LEGACY")).rejects.toThrow(/NAME_EXISTS[\s\S]*"kind":"folder"/);
  });

  it("rejects names containing / and dot names", async () => {
    const { owner, mkdir, touch } = await setup();
    await expect(mkdir("a/b")).rejects.toThrow("INVALID_NAME");
    await expect(mkdir("..")).rejects.toThrow("INVALID_NAME");
    await expect(touch("x/y.md")).rejects.toThrow("INVALID_NAME");
    const file = await touch("ok.md");
    await expect(
      owner.mutation(api.files.renameFile, { fileId: file.id, name: "a/ok.md", expectedVersion: 1 }),
    ).rejects.toThrow("INVALID_NAME");
    const folder = await mkdir("ok");
    await expect(
      owner.mutation(api.folders.renameFolder, { folderId: folder.id, name: "o/k", expectedRevision: 1 }),
    ).rejects.toThrow("INVALID_NAME");
  });

  it("resolvePath finds root, folders and files case-insensitively", async () => {
    const { t, workspaceId, mkdir, touch } = await setup();
    const specs = await mkdir("Specs");
    const file = await touch("API.md", specs.id);
    await t.run(async (ctx) => {
      expect(await resolvePath(ctx, workspaceId, "/")).toEqual({ kind: "root" });
      expect(await resolvePath(ctx, workspaceId, "specs/")).toMatchObject({
        kind: "folder",
        folder: { _id: specs.id },
      });
      expect(await resolvePath(ctx, workspaceId, "/SPECS/api.MD")).toMatchObject({
        kind: "file",
        file: { _id: file.id },
      });
      expect(await resolvePath(ctx, workspaceId, "/specs/missing.md")).toBeNull();
      expect(await resolvePath(ctx, workspaceId, "/nope/api.md")).toBeNull();
      // A file is not a directory.
      expect(await resolvePath(ctx, workspaceId, "/specs/api.md/x")).toBeNull();
      await expect(resolvePath(ctx, workspaceId, "/specs/../x")).rejects.toThrow("INVALID_PATH");
    });
  });

  it("rejects empty paths and empty segments like the MCP mock parser", async () => {
    const { t, workspaceId } = await setup();
    for (const path of ["", "//", "///", "specs//", "//specs", "/a//b"])
      expect(() => splitPath(path), path).toThrow("INVALID_PATH");
    expect(splitPath("/")).toEqual([]);
    expect(splitPath("specs/api/")).toEqual(["specs", "api"]);
    await t.run(async (ctx) => {
      await expect(resolvePath(ctx, workspaceId, "//")).rejects.toThrow("INVALID_PATH");
      await expect(resolvePath(ctx, workspaceId, "")).rejects.toThrow("INVALID_PATH");
    });
  });

  it("moveFile bumps the version, writes a revision row and event, and checks collisions", async () => {
    const { t, owner, mkdir, touch, events } = await setup();
    const specs = await mkdir("specs");
    const file = await touch("a.md", undefined, "body");
    const moved = await owner.mutation(api.files.moveFile, {
      fileId: file.id,
      parentId: specs.id,
      expectedVersion: 1,
    });
    expect(moved).toEqual({ version: 2 });
    const stored = await t.run((ctx) => ctx.db.get(file.id));
    expect(stored).toMatchObject({ parentId: specs.id, version: 2, revision: 2, content: "body" });
    const history = await owner.query(api.files.getFileVersions, { fileId: file.id });
    expect(history.map((r) => r.version)).toEqual([2, 1]);
    const revision = await owner.query(api.files.getFileRevision, { fileId: file.id, version: 2 });
    expect(revision?.content).toBe("body");
    expect((await events("file.moved")).map((e) => e.summary)).toEqual(["Moved a.md to /specs"]);
    await expect(
      owner.mutation(api.files.moveFile, { fileId: file.id, parentId: null, expectedVersion: 1 }),
    ).rejects.toThrow("VERSION_CONFLICT");
    await touch("A.MD");
    await expect(
      owner.mutation(api.files.moveFile, { fileId: file.id, parentId: null, expectedVersion: 2 }),
    ).rejects.toThrow(/NAME_EXISTS[\s\S]*"kind":"file"/);
    const other = await mkdir("other");
    await mkdir("a.md", other.id);
    await expect(
      owner.mutation(api.files.moveFile, { fileId: file.id, parentId: other.id, expectedVersion: 2 }),
    ).rejects.toThrow(/NAME_EXISTS[\s\S]*"kind":"folder"/);
    await expect(
      owner.mutation(api.files.renameFile, { fileId: file.id, name: "A.md", expectedVersion: 2 }),
    ).resolves.toMatchObject({ version: 3 });
  });

  it("rejects moving a folder into itself or a descendant", async () => {
    const { owner, mkdir } = await setup();
    const a = await mkdir("a");
    const b = await mkdir("b", a.id);
    const c = await mkdir("c", b.id);
    await expect(
      owner.mutation(api.folders.moveFolder, { folderId: a.id, parentId: a.id, expectedRevision: 1 }),
    ).rejects.toThrow("INVALID_MOVE");
    await expect(
      owner.mutation(api.folders.moveFolder, { folderId: a.id, parentId: c.id, expectedRevision: 1 }),
    ).rejects.toThrow("INVALID_MOVE");
    const moved = await owner.mutation(api.folders.moveFolder, {
      folderId: c.id,
      parentId: null,
      expectedRevision: 1,
    });
    expect(moved).toMatchObject({ path: "/c", parentId: null, revision: 2 });
    await mkdir("x", b.id);
    const x = (await owner.query(api.folders.listDirectory, { workspaceId: a.workspaceId, folderId: b.id })).folders[0]!;
    await expect(
      owner.mutation(api.folders.moveFolder, { folderId: x.id, parentId: null, expectedRevision: 1 }),
    ).resolves.toMatchObject({ path: "/x" });
    await mkdir("dup", b.id);
    await mkdir("DUP");
    const dup = (await owner.query(api.folders.listDirectory, { workspaceId: a.workspaceId, folderId: b.id })).folders[0]!;
    await expect(
      owner.mutation(api.folders.moveFolder, { folderId: dup.id, parentId: null, expectedRevision: 1 }),
    ).rejects.toThrow(/NAME_EXISTS[\s\S]*"kind":"folder"/);
  });

  it("enforces the depth limit on create and move", async () => {
    const { t, owner, workspaceId, actor, mkdir } = await setup();
    const path = Array.from({ length: MAX_FOLDER_DEPTH }, (_, i) => `d${i}`).join("/");
    const deepest = await t.run((ctx) => ensureFolderPathCore(ctx, { workspaceId, path, actor }));
    await expect(mkdir("too-deep", deepest.folder._id)).rejects.toThrow("FOLDER_TOO_DEEP");
    const tree = await mkdir("tree");
    await mkdir("leaf", tree.id);
    const parentOfDeepest = deepest.folder.parentId!;
    await expect(
      owner.mutation(api.folders.moveFolder, { folderId: tree.id, parentId: parentOfDeepest, expectedRevision: 1 }),
    ).rejects.toThrow("FOLDER_TOO_DEEP");
  });

  it("never lets a move of a wide subtree exceed the depth limit", async () => {
    const { t, owner, workspaceId, actor, mkdir } = await setup();
    const a = await mkdir("a");
    const d = await mkdir("d");
    const leafId = await t.run(async (ctx) => {
      const row = { workspaceId, createdBy: actor, updatedBy: actor, revision: 1, createdAt: 1, updatedAt: 1 };
      const mk = (name: string, parentId: Id<"folders">) =>
        ctx.db.insert("folders", { ...row, name, nameKey: name, parentId });
      // The last of MAX_INDEXED_FOLDERS + 1 children carries the deep chain.
      let id: Id<"folders"> = a.id;
      for (let i = 0; i <= MAX_INDEXED_FOLDERS; i++) id = await mk(`c${i}`, a.id);
      for (let i = 0; i < MAX_FOLDER_DEPTH - 2; i++) id = await mk(`n${i}`, id);
      return id;
    });
    const depth = () => t.run(async (ctx) => (await folderPath(ctx, leafId)).split("/").length - 1);
    expect(await depth()).toBe(MAX_FOLDER_DEPTH);
    await expect(
      owner.mutation(api.folders.moveFolder, { folderId: a.id, parentId: d.id, expectedRevision: 1 }),
    ).rejects.toThrow(/FOLDER_TOO_LARGE[\s\S]*"limit":2000/);
    expect(await depth()).toBe(MAX_FOLDER_DEPTH);
  });

  it("renameFolder with a stale revision is VERSION_CONFLICT", async () => {
    const { owner, mkdir, events } = await setup();
    const folder = await mkdir("drafts");
    const renamed = await owner.mutation(api.folders.renameFolder, {
      folderId: folder.id,
      name: "Final",
      expectedRevision: 1,
    });
    expect(renamed).toMatchObject({ name: "Final", path: "/Final", revision: 2 });
    expect((await events("folder.renamed")).length).toBe(1);
    await expect(
      owner.mutation(api.folders.renameFolder, { folderId: folder.id, name: "Other", expectedRevision: 1 }),
    ).rejects.toThrow(/VERSION_CONFLICT[\s\S]*"currentRevision":2/);
  });

  it("deleteFolder soft-deletes the subtree, tombstones files and frees names", async () => {
    const { t, owner, workspaceId, mkdir, touch, events } = await setup();
    const top = await mkdir("project");
    const inner = await mkdir("inner", top.id);
    const f1 = await touch("one.md", top.id, "1");
    const f2 = await touch("two.md", inner.id, "2");
    const keep = await touch("keep.md");
    const result = await owner.mutation(api.folders.deleteFolder, {
      folderId: top.id,
      expectedRevision: 1,
    });
    expect(result).toEqual({ deletedFiles: 2, deletedFolders: 2 });
    const rows = await t.run(async (ctx) => ({
      top: await ctx.db.get(top.id),
      inner: await ctx.db.get(inner.id),
      f1: await ctx.db.get(f1.id),
      f2: await ctx.db.get(f2.id),
      keep: await ctx.db.get(keep.id),
    }));
    for (const row of [rows.top, rows.inner, rows.f1, rows.f2]) {
      expect(row?.deletedAt).toBeTypeOf("number");
      expect(row?.nameKey).toBeUndefined();
      expect(row?.deletedBy).toMatchObject({ label: "Owner" });
    }
    expect(rows.f2?.content).toBe("2");
    expect(rows.keep?.deletedAt).toBeUndefined();
    expect((await events("file.deleted")).map((e) => e.entityId).sort()).toEqual([f1.id, f2.id].sort());
    expect((await events("folder.deleted")).map((e) => e.entityId)).toEqual([top.id]);
    await expect(
      owner.query(api.files.readFile, { fileId: f1.id }),
    ).rejects.toThrow("FILE_NOT_FOUND");
    // Names are released: recreate the same folder name.
    const again = await mkdir("Project");
    expect(again.path).toBe("/Project");
    const root = await owner.query(api.folders.listDirectory, { workspaceId });
    expect(root.folders.map((f) => f.name)).toEqual(["Project"]);
    // The deleted folder is gone for listing and as a parent.
    await expect(
      owner.query(api.folders.listDirectory, { workspaceId, folderId: top.id }),
    ).rejects.toThrow("FOLDER_NOT_FOUND");
    await expect(touch("x.md", top.id)).rejects.toThrow("INVALID_PARENT_FOLDER");
    await expect(
      owner.mutation(api.folders.renameFolder, { folderId: top.id, name: "y", expectedRevision: 2 }),
    ).rejects.toThrow("FOLDER_NOT_FOUND");
  });

  it("deleteFolder refuses subtrees over the item limit without writing", async () => {
    const { t, owner, workspaceId, actor, mkdir } = await setup();
    const big = await mkdir("big");
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let i = 0; i < 500; i++)
        await ctx.db.insert("files", {
          workspaceId,
          parentId: big.id,
          name: `f${i}.md`,
          nameKey: `f${i}.md`,
          mimeType: "text/markdown",
          content: "",
          version: 1,
          createdBy: actor,
          updatedBy: actor,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        });
    });
    await expect(
      owner.mutation(api.folders.deleteFolder, { folderId: big.id, expectedRevision: 1 }),
    ).rejects.toThrow("FOLDER_TOO_LARGE");
    expect((await t.run((ctx) => ctx.db.get(big.id)))?.deletedAt).toBeUndefined();
  });

  it("listDirectory returns breadcrumbs, sorted children and paths", async () => {
    const { owner, workspaceId, mkdir, touch } = await setup();
    const specs = await mkdir("specs");
    const apiDir = await mkdir("api", specs.id);
    await mkdir("zeta", apiDir.id);
    await mkdir("Alpha", apiDir.id);
    await touch("b.md", apiDir.id);
    await touch("A.md", apiDir.id);
    const listing = await owner.query(api.folders.listDirectory, {
      workspaceId,
      folderId: apiDir.id,
    });
    expect(listing.folder).toMatchObject({ id: apiDir.id, path: "/specs/api" });
    expect(listing.breadcrumbs).toEqual([
      { id: specs.id, name: "specs" },
      { id: apiDir.id, name: "api" },
    ]);
    expect(listing.folders.map((f) => f.path)).toEqual(["/specs/api/Alpha", "/specs/api/zeta"]);
    expect(listing.files.map((f) => f.path)).toEqual(["/specs/api/A.md", "/specs/api/b.md"]);
    const root = await owner.query(api.folders.listDirectory, { workspaceId });
    expect(root).toMatchObject({ folder: null, breadcrumbs: [] });
    expect(root.folders.map((f) => f.path)).toEqual(["/specs"]);
    const tree = await owner.query(api.folders.listFolderTree, { workspaceId });
    expect(tree.map((f) => f.path)).toEqual([
      "/specs",
      "/specs/api",
      "/specs/api/Alpha",
      "/specs/api/zeta",
    ]);
  });

  it("listDirectory is FOLDER_NOT_FOUND for another workspace's folder", async () => {
    const { t, owner, mkdir } = await setup();
    const folder = await mkdir("mine");
    const otherId = await t.run((ctx) => ctx.db.insert("users", { name: "Other" }));
    const other = t.withIdentity({ subject: `${otherId}|session` });
    const otherWorkspace = await other.mutation(api.workspaces.createWorkspace, { name: "Other" });
    await expect(
      other.query(api.folders.listDirectory, { workspaceId: otherWorkspace, folderId: folder.id }),
    ).rejects.toThrow("FOLDER_NOT_FOUND");
    await expect(
      other.mutation(api.folders.renameFolder, { folderId: folder.id, name: "x", expectedRevision: 1 }),
    ).rejects.toThrow("FOLDER_NOT_FOUND");
    expect(owner).toBeDefined();
  });
});
