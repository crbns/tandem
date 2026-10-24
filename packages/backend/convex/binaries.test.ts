/// <reference types="vite/client" />
import mcpTest from "@convex-dev/mcp/test";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { MAX_UPLOAD_BYTES, validateBinaryUpload } from "./lib/binaries";
import { ALL_MCP_SCOPES } from "./lib/mcpConfig";

declare const process: { env: Record<string, string | undefined> };
const modules = import.meta.glob("./**/*.ts");
beforeEach(() => {
  process.env.CONVEX_SITE_URL = "https://test.convex.site";
  process.env.SITE_URL = "https://tandem.example";
});
async function setup() {
  const t = convexTest(schema, modules);
  mcpTest.register(t);
  const ownerId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Owner" }),
  );
  const outsiderId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Outsider" }),
  );
  const owner = t.withIdentity({ subject: `${ownerId}|session` });
  const outsider = t.withIdentity({ subject: `${outsiderId}|session` });
  const workspaceId = await owner.mutation(api.workspaces.createWorkspace, {
    name: "Files",
  });
  const store = (content = "pdf bytes", type = "application/pdf") =>
    t.run((ctx) => ctx.storage.store(new Blob([content], { type })));
  const upload = async () =>
    owner.mutation(api.files.finalizeUpload, {
      workspaceId,
      storageId: await store(),
      name: "report.pdf",
    });
  return { t, owner, outsider, workspaceId, store, upload };
}

describe("binary uploads", () => {
  it("keeps renamed binary heads and revisions downloadable with their MIME and size", async () => {
    const { t, owner, workspaceId, upload, store } = await setup();
    const file = await upload();
    await owner.mutation(api.files.renameFile, { fileId: file.id, name: "renamed.pdf", expectedVersion: 1 });
    const path = `/files/${file.id}/content`;
    for (const suffix of ["", "?version=1", "?version=2"]) {
      const response = await owner.fetch(path + suffix);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/pdf");
      expect(response.headers.get("content-disposition")).toContain("renamed.pdf");
      expect(await response.text()).toBe("pdf bytes");
    }
    const revision = await t.run((ctx) => ctx.db.query("file_revisions")
      .withIndex("by_file_and_version", (q) => q.eq("fileId", file.id).eq("version", 2)).unique());
    expect(revision).toMatchObject({ storageId: expect.any(String), mimeType: "application/pdf", size: 9 });
    await owner.mutation(api.files.finalizeUpload, { workspaceId, fileId: file.id, name: "ignored.png", storageId: await store("png bytes", "image/png"), expectedVersion: 2 });
    const historical = await owner.fetch(path + "?version=2");
    expect(historical.headers.get("content-type")).toBe("application/pdf");
    expect(await historical.text()).toBe("pdf bytes");
    expect(await owner.query(api.files.readFile, { fileId: file.id })).toMatchObject({ file: { name: "renamed.pdf", version: 3 } });
  });

  it("blocks deleted binary content and finalization without appending history", async () => {
    const { t, owner, workspaceId, upload, store } = await setup();
    const file = await upload();
    await owner.mutation(api.files.deleteFile, { fileId: file.id, expectedVersion: 1 });
    for (const suffix of ["", "?version=1"]) {
      expect((await owner.fetch(`/files/${file.id}/content${suffix}`)).status).toBe(404);
    }
    const storageId = await store("replacement");
    await expect(owner.mutation(api.files.finalizeUpload, { workspaceId, fileId: file.id, name: file.name, storageId, expectedVersion: 1 })).rejects.toThrow("FILE_NOT_FOUND");
    expect(await t.run((ctx) => ctx.db.query("file_revisions").collect())).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.query("storage_objects").withIndex("by_storage_id", (q) => q.eq("storageId", storageId)).first())).toBeNull();
    // Deletion frees the canonical name for a new upload.
    expect(await upload()).toMatchObject({ name: file.name, version: 1 });
  });

  it("restores text history after rename and rejects restore after deletion", async () => {
    const { owner, workspaceId } = await setup();
    const file = await owner.mutation(api.files.createDocument, { workspaceId, name: "original.txt", mimeType: "text/plain", content: "original" });
    await owner.mutation(api.files.updateDocument, { fileId: file.id, content: "updated", expectedVersion: 1 });
    await owner.mutation(api.files.renameFile, { fileId: file.id, name: "renamed.txt", expectedVersion: 2 });
    expect(await owner.mutation(api.files.restoreRevision, { fileId: file.id, version: 1, expectedVersion: 3 })).toMatchObject({ name: "renamed.txt", version: 4 });
    expect(await owner.query(api.files.readFile, { fileId: file.id })).toMatchObject({ content: "original" });
    await owner.mutation(api.files.deleteFile, { fileId: file.id, expectedVersion: 4 });
    await expect(owner.mutation(api.files.restoreRevision, { fileId: file.id, version: 1, expectedVersion: 4 })).rejects.toThrow("FILE_NOT_FOUND");
  });

  it("requires membership to generate URLs and finalize uploads", async () => {
    const { t, owner, outsider, workspaceId, store } = await setup();
    expect(
      await owner.mutation(api.files.generateUploadUrl, { workspaceId }),
    ).toMatch(/^https?:/);
    await expect(
      t.mutation(api.files.generateUploadUrl, { workspaceId }),
    ).rejects.toThrow(/UNAUTHENTICATED/);
    await expect(
      outsider.mutation(api.files.generateUploadUrl, { workspaceId }),
    ).rejects.toThrow(/FORBIDDEN/);
    await expect(
      outsider.mutation(api.files.finalizeUpload, {
        workspaceId,
        name: "x.pdf",
        storageId: await store(),
      }),
    ).rejects.toThrow(/FORBIDDEN/);
  });
  it("validates stored MIME and size before creating any file", async () => {
    const { t, owner, workspaceId, store } = await setup();
    for (const [content, type, error] of [
      ["x", "text/html", "UNSUPPORTED_MIME_TYPE"],
      ["", "image/png", "INVALID_UPLOAD_SIZE"],
    ]) {
      await expect(
        owner.mutation(api.files.finalizeUpload, {
          workspaceId,
          name: "bad",
          storageId: await store(content, type),
        }),
      ).rejects.toThrow(error);
    }
    expect(() =>
      validateBinaryUpload(MAX_UPLOAD_BYTES + 1, "application/pdf"),
    ).toThrow(/INVALID_UPLOAD_SIZE/);
    // Exercise the mutation's size check against real storage metadata too.
    const big = await t.run((ctx) =>
      ctx.storage.store(
        new Blob([new Uint8Array(MAX_UPLOAD_BYTES + 1)], {
          type: "application/pdf",
        }),
      ),
    );
    await expect(
      owner.mutation(api.files.finalizeUpload, {
        workspaceId,
        name: "large.pdf",
        storageId: big,
      }),
    ).rejects.toThrow(/INVALID_UPLOAD_SIZE/);
    expect(await t.run((ctx) => ctx.db.query("files").collect())).toEqual([]);
  });
  it("creates attributed file, storage, revision, event and outbox atomically", async () => {
    const { t, upload } = await setup();
    const file = await upload();
    expect(file.version).toBe(1);
    const result = await t.run(async (ctx) => ({
      file: await ctx.db.get(file.id),
      storage: await ctx.db.query("storage_objects").first(),
      revision: await ctx.db.query("file_revisions").first(),
      event: await ctx.db.query("workspace_events").order("desc").first(),
      outbox: await ctx.db.query("outbox_events").order("desc").first(),
    }));
    expect(result.file?.content).toBeUndefined();
    expect(result.storage?.uploadedBy).toEqual(file.updatedBy);
    expect(result.revision?.storageId).toBe(result.file?.storageId);
    expect(result.event).toMatchObject({
      kind: "file.created",
      entityId: file.id,
      actor: file.updatedBy,
    });
    expect(result.outbox?.eventId).toBe(result.event?._id);
  });
  it("creates new versions, preserves blobs and rejects stale or missing expectedVersion", async () => {
    const { t, owner, workspaceId, upload, store } = await setup();
    const file = await upload();
    const storageId = await store("new pdf");
    const input = { workspaceId, name: file.name, fileId: file.id, storageId };
    await expect(
      owner.mutation(api.files.finalizeUpload, input),
    ).rejects.toThrow(/INVALID_INPUT/);
    const next = await owner.mutation(api.files.finalizeUpload, {
      ...input,
      expectedVersion: 1,
    });
    expect(next.version).toBe(2);
    await expect(
      owner.mutation(api.files.finalizeUpload, {
        ...input,
        storageId: await store(),
        expectedVersion: 1,
      }),
    ).rejects.toThrow(/VERSION_CONFLICT/);
    await expect(
      owner.mutation(api.files.updateDocument, {
        fileId: file.id,
        expectedVersion: 2,
        content: "text",
      }),
    ).rejects.toThrow(/BINARY_FILE/);
    const revisions = await t.run((ctx) =>
      ctx.db.query("file_revisions").collect(),
    );
    expect(revisions.map((r) => r.version)).toEqual([1, 2]);
    expect(
      await t.run((ctx) =>
        ctx.storage.get(revisions[0]!.storageId!).then((blob) => blob !== null),
      ),
    ).toBe(true);
    await expect(
      owner.mutation(api.files.finalizeUpload, {
        workspaceId,
        storageId,
        name: "duplicate.pdf",
      }),
    ).rejects.toThrow(/UPLOAD_ALREADY_FINALIZED/);
  });
  it("streams private blobs only to members with CORS and correct historical MIME", async () => {
    const { t, owner, outsider, workspaceId, upload, store } = await setup();
    const file = await upload();
    const path = `/files/${file.id}/content`;
    expect((await t.fetch(path)).status).toBe(401);
    expect((await outsider.fetch(path)).status).toBe(403);
    const response = await owner.fetch(path, {
      headers: { Origin: "https://tandem.example" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://tandem.example",
    );
    expect(await response.text()).toBe("pdf bytes");
    const options = await t.fetch(path, {
      method: "OPTIONS",
      headers: { Origin: "https://tandem.example" },
    });
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-headers")).toBe(
      "Authorization",
    );
    await owner.mutation(api.files.finalizeUpload, {
      workspaceId,
      fileId: file.id,
      name: file.name,
      storageId: await store("png bytes", "image/png"),
      expectedVersion: 1,
    });
    expect((await owner.fetch(path)).headers.get("content-type")).toBe(
      "image/png",
    );
    const old = await owner.fetch(`${path}?version=1`);
    expect(old.headers.get("content-type")).toBe("application/pdf");
    expect(await old.text()).toBe("pdf bytes");
    expect((await owner.fetch(`${path}?version=3`)).status).toBe(404);
    expect((await owner.fetch(`${path}?version=NaN`)).status).toBe(400);
    expect((await owner.fetch("/files/invalid/content")).status).toBe(404);
  });
  it("MCP read_file describes a binary and reports its byte size", async () => {
    const { t, owner, workspaceId, upload } = await setup();
    const file = await upload();
    const connection = await owner.action(
      api.agentConnections.createAgentConnection,
      { workspaceId, client: "claude" },
    );
    const principal = {
      userId: connection.connectionId,
      scopes: ALL_MCP_SCOPES,
      connectionId: "grant",
    };
    const result = await t.mutation(internal.mcpTools.readFile, {
      principal,
      fileId: file.id,
    });
    expect(result.file.mimeType).toBe("application/pdf");
    expect(result.content).toBe("binary: view or download in the dashboard");
    // An older binary revision reads the same way as the head, not as an error.
    await owner.mutation(api.files.renameFile, { fileId: file.id, name: "report-v2.pdf", expectedVersion: 1 });
    const older = await t.mutation(internal.mcpTools.readFile, { principal, fileId: file.id, version: 1 });
    expect(older).toMatchObject({ version: 1, content: "binary: view or download in the dashboard" });
    const versions = await t.mutation(internal.mcpTools.getFileVersions, {
      principal,
      fileId: file.id,
      limit: 10,
    });
    expect(versions.versions[0]?.sizeBytes).toBe(9);
    // Binary revisions have no line counts.
    expect(versions.versions.map((v) => v.change)).toEqual([null, null]);
  });
});
