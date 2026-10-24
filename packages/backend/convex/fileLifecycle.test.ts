/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { toSyncResult } from "./lib/mcpContract";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Owner" }),
  );
  const memberId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Member" }),
  );
  const owner = t.withIdentity({ subject: `${userId}|session` });
  const member = t.withIdentity({ subject: `${memberId}|session` });
  const workspaceId = await owner.mutation(api.workspaces.createWorkspace, {
    name: "Lifecycle",
  });
  await t.run(async (ctx) => {
    const actor = { type: "human" as const, userId, label: "Owner" };
    await ctx.db.insert("workspace_members", {
      workspaceId,
      userId: memberId,
      role: "member",
      updatedBy: actor,
      revision: 1,
      joinedAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
  const connectionId = await t.run((ctx) =>
    ctx.db.insert("agent_connections", {
      workspaceId,
      userId: memberId,
      client: "claude",
      createdAt: Date.now(),
      revision: 1,
      updatedBy: { type: "human", userId: memberId, label: "Member" },
    }),
  );
  const principal = {
    userId: connectionId,
    connectionId: "test_grant",
    scopes: ["tandem:read", "tandem:write"],
  };
  const file = await owner.mutation(api.files.createDocument, {
    workspaceId,
    name: "notes.md",
    mimeType: "text/markdown",
    content: "retained content",
  });
  return { t, owner, member, memberId, workspaceId, principal, file };
}

const page = { numItems: 100, cursor: null };

describe("rename and soft delete files", () => {
  it("lets an ordinary member rename and exposes it on the next agent list_files", async () => {
    const { t, member, memberId, workspaceId, principal, file } = await setup();
    const renamed = await member.mutation(api.files.renameFile, {
      fileId: file.id,
      name: "  Plan.md  ",
      expectedVersion: 1,
    });
    expect(renamed).toMatchObject({
      name: "Plan.md",
      version: 2,
      updatedBy: { userId: memberId },
    });
    const stored = await t.run((ctx) => ctx.db.get(file.id));
    expect(stored).toMatchObject({ revision: 2, nameKey: "plan.md" });
    const listed = await t.mutation(internal.mcpTools.listFiles, { principal });
    expect(listed.files).toContainEqual(
      expect.objectContaining({ id: file.id, name: "Plan.md", version: 2 }),
    );
    const sync = await t.mutation(internal.mcpTools.syncWorkspace, {
      principal,
    });
    expect(sync.events).toContainEqual(
      expect.objectContaining({ kind: "file.renamed", entityId: file.id }),
    );
    const history = await member.query(api.files.getFileVersions, {
      fileId: file.id,
    });
    expect(history.map((r) => r.version)).toEqual([2, 1]);
    expect(
      (
        await member.query(api.files.listFiles, {
          workspaceId,
          paginationOpts: page,
        })
      ).page[0]?.name,
    ).toBe("Plan.md");
  });

  it("uses normalized NAME_EXISTS, rejects invalid names and stale metadata writes", async () => {
    const { owner, member, workspaceId, file } = await setup();
    await owner.mutation(api.files.createDocument, {
      workspaceId,
      name: "Other.md",
      mimeType: "text/markdown",
      content: "",
    });
    await expect(
      member.mutation(api.files.renameFile, {
        fileId: file.id,
        name: " OTHER.MD ",
        expectedVersion: 1,
      }),
    ).rejects.toThrow("NAME_EXISTS");
    await expect(
      member.mutation(api.files.renameFile, {
        fileId: file.id,
        name: "\u200b ",
        expectedVersion: 1,
      }),
    ).rejects.toThrow("INVALID_NAME");
    await member.mutation(api.files.renameFile, {
      fileId: file.id,
      name: "NOTES.md",
      expectedVersion: 1,
    });
    await expect(
      member.mutation(api.files.renameFile, {
        fileId: file.id,
        name: "stale.md",
        expectedVersion: 1,
      }),
    ).rejects.toThrow("VERSION_CONFLICT");
    await expect(
      member.mutation(api.files.deleteFile, {
        fileId: file.id,
        expectedVersion: 1,
      }),
    ).rejects.toThrow("VERSION_CONFLICT");
    expect(
      (await member.query(api.files.readFile, { fileId: file.id })).file.name,
    ).toBe("NOTES.md");
  });

  it("soft deletes for any member, emits a sync tombstone and keeps DB revisions", async () => {
    const { t, owner, member, memberId, workspaceId, principal, file } =
      await setup();
    await owner.mutation(api.files.updateDocument, {
      fileId: file.id,
      content: "second version",
      expectedVersion: 1,
    });
    const before = await t.mutation(internal.mcpTools.syncWorkspace, {
      principal,
    });
    await member.mutation(api.files.deleteFile, {
      fileId: file.id,
      expectedVersion: 2,
    });
    const stored = await t.run((ctx) => ctx.db.get(file.id));
    expect(stored).toMatchObject({
      deletedAt: expect.any(Number),
      deletedBy: { userId: memberId },
      revision: 3,
      content: "second version",
    });
    const revisions = await t.run((ctx) =>
      ctx.db
        .query("file_revisions")
        .withIndex("by_file_and_version", (q) => q.eq("fileId", file.id))
        .collect(),
    );
    expect(revisions.map((r) => [r.version, r.content])).toEqual([
      [1, "retained content"],
      [2, "second version"],
    ]);
    expect(
      (
        await member.query(api.files.listFiles, {
          workspaceId,
          paginationOpts: page,
        })
      ).page,
    ).toEqual([]);
    expect(
      (
        await member.query(api.files.listFiles, {
          workspaceId,
          query: "notes",
          paginationOpts: page,
        })
      ).page,
    ).toEqual([]);
    expect(
      (await t.mutation(internal.mcpTools.listFiles, { principal })).files,
    ).toEqual([]);
    expect(
      (
        await t.mutation(internal.mcpTools.listFiles, {
          principal,
          query: "notes",
        })
      ).files,
    ).toEqual([]);
    expect(
      await t.mutation(internal.mcpTools.searchFiles, {
        principal,
        query: "second",
        limit: 10,
      }),
    ).toEqual([]);
    const incremental = await t.mutation(internal.mcpTools.syncWorkspace, {
      principal,
      sinceSeq: before.cursorSeq,
    });
    expect(incremental.changedFiles).toEqual([]);
    expect(toSyncResult(incremental).events).toContainEqual(
      expect.objectContaining({ type: "file.deleted", subject_id: file.id }),
    );
    expect(
      (await t.mutation(internal.mcpTools.syncWorkspace, { principal }))
        .changedFiles,
    ).toEqual([]);
    await expect(
      member.query(api.files.readFile, { fileId: file.id }),
    ).rejects.toThrow("FILE_NOT_FOUND");
    await expect(
      member.mutation(api.files.updateDocument, {
        fileId: file.id,
        content: "oops",
        expectedVersion: 2,
      }),
    ).rejects.toThrow("FILE_NOT_FOUND");
    await expect(
      t.mutation(internal.mcpTools.readFile, { principal, fileId: file.id }),
    ).rejects.toThrow("FILE_NOT_FOUND");
    await expect(
      t.mutation(internal.mcpTools.updateDocument, {
        principal,
        fileId: file.id,
        content: "oops",
        expectedVersion: 2,
      }),
    ).rejects.toThrow("FILE_NOT_FOUND");
    const replacement = await owner.mutation(api.files.createDocument, {
      workspaceId,
      name: "NOTES.md",
      mimeType: "text/markdown",
      content: "new",
    });
    expect(replacement.id).not.toBe(file.id);
    await member.mutation(api.files.renameFile, {
      fileId: replacement.id,
      name: "new.md",
      expectedVersion: 1,
    });
    await member.mutation(api.files.renameFile, {
      fileId: replacement.id,
      name: "notes.md",
      expectedVersion: 2,
    });
  });

  it("rejects nonmembers without changing the file", async () => {
    const { t, file } = await setup();
    const outsiderId = await t.run((ctx) =>
      ctx.db.insert("users", { name: "Outsider" }),
    );
    const outsider = t.withIdentity({ subject: `${outsiderId}|session` });
    await expect(
      outsider.mutation(api.files.renameFile, {
        fileId: file.id,
        name: "no.md",
        expectedVersion: 1,
      }),
    ).rejects.toThrow("FILE_NOT_FOUND");
    await expect(
      outsider.mutation(api.files.deleteFile, {
        fileId: file.id,
        expectedVersion: 1,
      }),
    ).rejects.toThrow("FILE_NOT_FOUND");
    expect(await t.run((ctx) => ctx.db.get(file.id))).toMatchObject({
      name: "notes.md",
      version: 1,
    });
  });
});
