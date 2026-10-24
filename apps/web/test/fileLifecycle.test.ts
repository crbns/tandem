import { describe, expect, it } from "vitest";
import { createMockApi, MOCK_WORKSPACE_ID } from "@/lib/api/mock";

const makeApi = () =>
  createMockApi({
    latencyMs: [0, 0],
    getActor: () => ({
      actorType: "human",
      userId: "user_demo",
      userName: "Demo",
    }),
  });

describe("mock file lifecycle parity", () => {
  it("normalizes rename collisions, snapshots history and rejects stale versions", async () => {
    const api = makeApi();
    const file = await api.createFile(MOCK_WORKSPACE_ID, {
      name: "original.md",
      mimeType: "text/markdown",
      content: "keep",
    });
    await expect(
      api.renameFile(file.id, " BRIEF.MD ", 1),
    ).rejects.toMatchObject({ code: "NAME_EXISTS" });
    await expect(api.renameFile(file.id, "\u200b ", 1)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(await api.renameFile(file.id, "  Final.md ", 1)).toEqual({
      version: 2,
    });
    expect(
      (await api.listFiles(MOCK_WORKSPACE_ID)).find((f) => f.id === file.id)
        ?.name,
    ).toBe("Final.md");
    expect(
      (await api.listRevisions(file.id)).map((r) => [r.version, r.content]),
    ).toEqual([
      [2, "keep"],
      [1, "keep"],
    ]);
    await expect(api.renameFile(file.id, "stale.md", 1)).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
    });
    await expect(api.deleteFile(file.id, 1)).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
    });
    await expect(
      api.createFile(MOCK_WORKSPACE_ID, {
        name: "FINAL.md",
        mimeType: "text/markdown",
        content: "",
      }),
    ).rejects.toMatchObject({ code: "NAME_EXISTS" });
  });

  it("hides deleted files, rejects reads/updates, notifies watchers and frees names", async () => {
    const api = makeApi();
    const file = await api.createFile(MOCK_WORKSPACE_ID, {
      name: "reusable.md",
      mimeType: "text/markdown",
      content: "keep",
    });
    let notifications = 0;
    api.watchWorkspace(MOCK_WORKSPACE_ID, () => {
      notifications++;
    });
    await api.deleteFile(file.id, 1);
    expect(notifications).toBe(1);
    expect(
      (await api.listFiles(MOCK_WORKSPACE_ID)).some((f) => f.id === file.id),
    ).toBe(false);
    await expect(api.readFile(file.id)).rejects.toMatchObject({
      code: "FILE_NOT_FOUND",
    });
    await expect(
      api.updateFileContent(file.id, { expectedVersion: 1, content: "oops" }),
    ).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
    const replacement = await api.createFile(MOCK_WORKSPACE_ID, {
      name: "Reusable.md",
      mimeType: "text/markdown",
      content: "new",
    });
    expect(replacement.id).not.toBe(file.id);
  });
});
