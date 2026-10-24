import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import { createConvexApi } from "@/lib/api/convex";
import { createMockApi, MOCK_WORKSPACE_ID } from "@/lib/api/mock";

const actor = { actorType: "human" as const, userId: "human", userName: "Alex" };
afterEach(() => vi.unstubAllGlobals());

describe("binary file adapter", () => {
  it("posts the blob before finalizing an optimistic replacement", async () => {
    const mutation = vi.fn(async (reference, args) => {
      const name = getFunctionName(reference);
      if (name === "files:generateUploadUrl") return "https://upload.example";
      expect(name).toBe("files:finalizeUpload");
      expect(args).toEqual({ workspaceId: "ws", storageId: "stored", name: "new.pdf", fileId: "file", expectedVersion: 2 });
      return { id: "file", version: 3 };
    });
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ storageId: "stored" })));
    vi.stubGlobal("fetch", request);
    const file = new File(["pdf"], "new.pdf", { type: "application/pdf" });
    const api = createConvexApi({ mutation } as unknown as ConvexReactClient);
    expect(await api.uploadFile("ws", file, { fileId: "file", expectedVersion: 2 })).toEqual({ id: "file", version: 3 });
    expect(request).toHaveBeenCalledWith("https://upload.example", { method: "POST", headers: { "Content-Type": "application/pdf" }, body: file });
    expect(mutation).toHaveBeenCalledTimes(2);
  });

  it("does not finalize a failed upload", async () => {
    const mutation = vi.fn().mockResolvedValue("https://upload.example");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    const api = createConvexApi({ mutation } as unknown as ConvexReactClient);
    await expect(api.uploadFile("ws", new File(["data"], "file.bin"))).rejects.toMatchObject({ code: "NETWORK" });
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  it("requests historical bytes using a bearer token and the Convex site host", async () => {
    const request = vi.fn().mockResolvedValue(new Response("original", { headers: { "Content-Type": "application/pdf" } }));
    vi.stubGlobal("fetch", request);
    const api = createConvexApi({ url: "https://example.convex.cloud" } as ConvexReactClient, () => "session-token");
    const blob = await api.getFileBlob("file", 1);
    expect(await blob.text()).toBe("original");
    expect(String(request.mock.calls[0]![0])).toBe("https://example.convex.site/files/file/content?version=1");
    expect(request.mock.calls[0]![1]).toEqual({ headers: { Authorization: "Bearer session-token" } });
  });

  it("uses the local Convex HTTP action port", async () => {
    const request = vi.fn().mockResolvedValue(new Response("data"));
    vi.stubGlobal("fetch", request);
    const api = createConvexApi({ url: "http://127.0.0.1:3212" } as ConvexReactClient, () => "token");
    await api.getFileBlob("file");
    expect(String(request.mock.calls[0]![0])).toBe("http://127.0.0.1:3213/files/file/content");
  });

  it("rejects unauthenticated content reads before fetching", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const api = createConvexApi({} as ConvexReactClient);
    await expect(api.getFileBlob("file")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(request).not.toHaveBeenCalled();
  });
});

describe("mock binary history", () => {
  it("retains original bytes and name after replacement and rejects stale versions", async () => {
    const api = createMockApi({ latencyMs: [0, 0], getActor: () => actor });
    const created = await api.uploadFile(MOCK_WORKSPACE_ID, new File(["original"], "design.pdf", { type: "application/pdf" }));
    await api.uploadFile(MOCK_WORKSPACE_ID, new File(["replacement"], "other.pdf", { type: "application/pdf" }), { fileId: created.id, expectedVersion: 1 });
    expect(await (await api.getFileBlob(created.id, 1)).text()).toBe("original");
    expect(await (await api.getFileBlob(created.id)).text()).toBe("replacement");
    expect(await api.readFile(created.id)).toMatchObject({ name: "design.pdf", content: null, version: 2 });
    expect((await api.listRevisions(created.id)).map((revision) => revision.version)).toEqual([2, 1]);
    await expect(api.uploadFile(MOCK_WORKSPACE_ID, new File(["stale"], "design.pdf"), { fileId: created.id, expectedVersion: 1 })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });
});
