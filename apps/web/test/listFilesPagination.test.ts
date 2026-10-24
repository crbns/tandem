import { describe, expect, it, vi } from "vitest";
import type { ConvexReactClient } from "convex/react";
import { createConvexApi, MAX_LIST_FILES } from "@/lib/api/convex";

function metadata(id: string) {
  return {
    id, workspaceId: "workspace", parentId: null, name: `${id}.md`,
    mimeType: "text/markdown", version: 1, updatedAt: 1,
    updatedBy: { type: "human", userId: "user", label: "Teammate" },
  };
}

function adapter(query: ReturnType<typeof vi.fn>) {
  return createConvexApi({ query } as unknown as ConvexReactClient);
}

describe("Convex listFiles pagination", () => {
  it("loads every page with the same workspace, maps metadata, and follows cursors", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ page: Array.from({ length: 100 }, (_, i) => metadata(`file_${i}`)), isDone: false, continueCursor: "next" })
      .mockResolvedValueOnce({ page: [metadata("beyond_first_100")], isDone: true, continueCursor: "end" });
    const files = await adapter(query).listFiles("workspace");
    expect(files).toHaveLength(101);
    expect(files[100]).toMatchObject({ id: "beyond_first_100", updatedBy: { actorType: "human", userName: "Teammate" } });
    expect(query).toHaveBeenNthCalledWith(1, expect.anything(), { workspaceId: "workspace", paginationOpts: { numItems: 100, cursor: null } });
    expect(query).toHaveBeenNthCalledWith(2, expect.anything(), { workspaceId: "workspace", paginationOpts: { numItems: 100, cursor: "next" } });
  });

  it("follows an empty nonterminal page and returns an empty terminal list", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ page: [], isDone: false, continueCursor: "next" })
      .mockResolvedValueOnce({ page: [], isDone: true, continueCursor: "end" });
    await expect(adapter(query).listFiles("workspace")).resolves.toEqual([]);
  });

  it("rejects rather than returning a partial list at the total/page cap", async () => {
    const query = vi.fn().mockImplementation(async (_ref, args: { paginationOpts: { cursor: string | null } }) => ({
      page: Array.from({ length: 100 }, (_, i) => metadata(`file_${args.paginationOpts.cursor}_${i}`)),
      isDone: false, continueCursor: String(Number(args.paginationOpts.cursor ?? 0) + 1),
    }));
    await expect(adapter(query).listFiles("workspace")).rejects.toMatchObject({ code: "LIST_LIMIT_EXCEEDED" });
    expect(query).toHaveBeenCalledTimes(MAX_LIST_FILES / 100);
  });

  it("allows exactly the cap when the last page is terminal", async () => {
    let page = 0;
    const query = vi.fn().mockImplementation(async () => ({
      page: Array.from({ length: 100 }, (_, i) => metadata(`file_${page}_${i}`)),
      isDone: ++page === MAX_LIST_FILES / 100, continueCursor: String(page),
    }));
    await expect(adapter(query).listFiles("workspace")).resolves.toHaveLength(MAX_LIST_FILES);
  });

  it("does not spin forever on a repeated cursor", async () => {
    const query = vi.fn().mockResolvedValue({ page: [], isDone: false, continueCursor: "stuck" });
    await expect(adapter(query).listFiles("workspace")).rejects.toMatchObject({ code: "LIST_LIMIT_EXCEEDED" });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("propagates a later-page failure instead of returning the first page", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ page: [metadata("first")], isDone: false, continueCursor: "next" })
      .mockRejectedValueOnce(new Error("NetworkError"));
    await expect(adapter(query).listFiles("workspace")).rejects.toMatchObject({ code: "NETWORK" });
  });
});
