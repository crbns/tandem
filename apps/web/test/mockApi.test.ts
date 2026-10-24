import { beforeEach, describe, expect, it } from "vitest";
import { createMockApi, MOCK_WORKSPACE_ID, type MockTandemApi } from "@/lib/api/mock";
import { TandemApiError } from "@/lib/api/errors";
import type { Actor } from "@/lib/api/types";

const human: Actor = { actorType: "human", actorId: "user_demo", actorName: "Demo Human" };
const claude: Actor = { actorType: "agent", actorId: "agent_claude", actorName: "Claude" };

async function expectApiError(promise: Promise<unknown>) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TandemApiError);
  return err as TandemApiError;
}

describe("mock TandemApi", () => {
  let api: MockTandemApi;

  beforeEach(() => {
    api = createMockApi({ latencyMs: [0, 0], getActor: () => human });
  });

  it("seeds proposal.md v1, brief.md v2, notes.txt v1", async () => {
    const files = await api.listFiles(MOCK_WORKSPACE_ID);
    const byName = Object.fromEntries(files.map((f) => [f.name, f]));
    expect(byName["proposal.md"]?.version).toBe(1);
    expect(byName["proposal.md"]?.updatedBy.actorType).toBe("agent");
    expect(byName["brief.md"]?.version).toBe(2);
    expect(byName["brief.md"]?.updatedBy.actorName).toBe("Alex");
    expect(byName["notes.txt"]?.version).toBe(1);
    expect(byName["notes.txt"]?.mimeType).toBe("text/plain");
  });

  it("creates a file at version 1 authored by the current actor", async () => {
    const { id, version } = await api.createFile(MOCK_WORKSPACE_ID, {
      name: "plan.md",
      mimeType: "text/markdown",
      content: "# Plan",
    });
    expect(version).toBe(1);
    const file = await api.readFile(id);
    expect(file.content).toBe("# Plan");
    expect(file.updatedBy).toEqual(human);
  });

  it("bumps the version when expectedVersion matches", async () => {
    const { id } = await api.createFile(MOCK_WORKSPACE_ID, { name: "a.md", mimeType: "text/markdown" });
    const result = await api.updateFileContent(id, { expectedVersion: 1, content: "v2 text" });
    expect(result.version).toBe(2);
    expect((await api.readFile(id)).content).toBe("v2 text");
  });

  it("rejects a stale write with VERSION_CONFLICT and keeps the newer content", async () => {
    const { id } = await api.createFile(MOCK_WORKSPACE_ID, { name: "a.md", mimeType: "text/markdown" });
    await api.updateFileContent(id, { expectedVersion: 1, content: "v2 text" });

    const err = await expectApiError(api.updateFileContent(id, { expectedVersion: 1, content: "stale" }));
    expect(err.code).toBe("VERSION_CONFLICT");
    expect(err.details.currentVersion).toBe(2);
    expect(err.details.currentContent).toBe("v2 text");

    const file = await api.readFile(id);
    expect(file.version).toBe(2);
    expect(file.content).toBe("v2 text");
  });

  it("lists revisions newest first with the correct actors", async () => {
    const files = await api.listFiles(MOCK_WORKSPACE_ID);
    const brief = files.find((f) => f.name === "brief.md");
    const revisions = await api.listRevisions(brief!.id);
    expect(revisions.map((r) => [r.version, r.actorType, r.actorName])).toEqual([
      [2, "human", "Alex"],
      [1, "agent", "Claude"],
    ]);
  });

  it("appends an immutable revision for each save", async () => {
    const { id } = await api.createFile(MOCK_WORKSPACE_ID, { name: "a.md", mimeType: "text/markdown", content: "one" });
    await api.updateFileContent(id, { expectedVersion: 1, content: "two" });
    const revisions = await api.listRevisions(id);
    expect(revisions.map((r) => [r.version, r.content])).toEqual([
      [2, "two"],
      [1, "one"],
    ]);
    revisions[0]!.content = "tampered";
    expect((await api.listRevisions(id))[0]!.content).toBe("two");
  });

  it("returns FILE_NOT_FOUND for an unknown file", async () => {
    expect((await expectApiError(api.readFile("nope"))).code).toBe("FILE_NOT_FOUND");
  });

  it("simulates an external agent edit that makes the dashboard's base stale", async () => {
    const { id } = await api.createFile(MOCK_WORKSPACE_ID, { name: "a.md", mimeType: "text/markdown" });
    api.__simulateExternalEdit(id, "agent text", claude);

    const err = await expectApiError(api.updateFileContent(id, { expectedVersion: 1, content: "mine" }));
    expect(err.code).toBe("VERSION_CONFLICT");
    expect(err.details.updatedBy).toEqual(claude);
  });
});
