import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { createConvexApi } from "@/lib/api/convex";
import { createMockApi, MOCK_WORKSPACE_ID } from "@/lib/api/mock";

const actor = { actorType: "human" as const, userId: "human", userName: "Alex" };
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

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
    expect(request).toHaveBeenCalledWith("https://upload.example", { method: "POST", headers: { "Content-Type": "application/pdf" }, body: file, signal: expect.any(AbortSignal) });
    expect(mutation).toHaveBeenCalledTimes(2);
  });

  it("waits for a successful slow upload and finalization without reporting a timeout", async () => {
    vi.useFakeTimers();
    const mutation = vi.fn(async (reference) => {
      if (getFunctionName(reference) === "files:generateUploadUrl") return "https://upload.example";
      await new Promise((resolve) => setTimeout(resolve, 16_000));
      return { id: "file", version: 1 };
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16_000));
      return new Response(JSON.stringify({ storageId: "stored" }));
    }));
    const api = createConvexApi({ mutation } as unknown as ConvexReactClient);
    const settled = vi.fn();
    const result = api.uploadFile("ws", new File(["pdf"], "slow.pdf", { type: "application/pdf" }));
    void result.then(settled, settled);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(mutation).toHaveBeenCalledTimes(2);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toEqual({ id: "file", version: 1 });
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
  it.each(["image/svg+xml", "text/plain", "video/mp4"])("rejects unsupported upload MIME %s without creating a file", async (type) => {
    const api = createMockApi({ latencyMs: [0, 0], getActor: () => actor });
    const before = await api.listFiles(MOCK_WORKSPACE_ID);
    await expect(api.uploadFile(MOCK_WORKSPACE_ID, new File(["data"], "unsupported", { type }))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await api.listFiles(MOCK_WORKSPACE_ID)).toEqual(before);
  });

  it.each([0, 25 * 1024 * 1024 + 1])("rejects upload size %s without creating a file", async (size) => {
    const api = createMockApi({ latencyMs: [0, 0], getActor: () => actor });
    const before = await api.listFiles(MOCK_WORKSPACE_ID);
    await expect(api.uploadFile(MOCK_WORKSPACE_ID, new File([new Uint8Array(size)], "large.pdf", { type: "application/pdf" }))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await api.listFiles(MOCK_WORKSPACE_ID)).toEqual(before);
  });

  it("rejects text saves on binaries with the Convex error and preserves the head bytes and history", async () => {
    const api = createMockApi({ latencyMs: [0, 0], getActor: () => actor });
    const created = await api.uploadFile(MOCK_WORKSPACE_ID, new File(["pdf"], "design.pdf", { type: "application/pdf" }));
    if (created.pending) throw new Error("Mock upload must finish");
    const mutation = vi.fn().mockRejectedValue(new ConvexError({ code: "BINARY_FILE" }));
    const convexApi = createConvexApi({ mutation } as unknown as ConvexReactClient);
    for (const expectedVersion of [1, 99]) {
      const update = { expectedVersion, content: "text" };
      await expect(api.updateFileContent(created.id, update)).rejects.toMatchObject({ code: "BINARY_FILE" });
      await expect(convexApi.updateFileContent(created.id, update)).rejects.toMatchObject({ code: "BINARY_FILE" });
    }
    expect(await api.readFile(created.id)).toMatchObject({ content: null, version: 1 });
    expect((await api.listRevisions(created.id)).map((revision) => revision.version)).toEqual([1]);
    expect(await (await api.getFileBlob(created.id)).text()).toBe("pdf");
  });

  it("retains original bytes and name after replacement and rejects stale versions", async () => {
    const api = createMockApi({ latencyMs: [0, 0], getActor: () => actor });
    const created = await api.uploadFile(MOCK_WORKSPACE_ID, new File(["original"], "design.pdf", { type: "application/pdf" }));
    if (created.pending) throw new Error("Mock upload must finish");
    await api.uploadFile(MOCK_WORKSPACE_ID, new File(["replacement"], "other.pdf", { type: "application/pdf" }), { fileId: created.id, expectedVersion: 1 });
    expect(await (await api.getFileBlob(created.id, 1)).text()).toBe("original");
    expect(await (await api.getFileBlob(created.id)).text()).toBe("replacement");
    expect(await api.readFile(created.id)).toMatchObject({ name: "design.pdf", content: null, version: 2 });
    expect((await api.listRevisions(created.id)).map((revision) => revision.version)).toEqual([2, 1]);
    await expect(api.uploadFile(MOCK_WORKSPACE_ID, new File(["stale"], "design.pdf"), { fileId: created.id, expectedVersion: 1 })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });
});
