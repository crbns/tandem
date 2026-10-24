import { describe, expect, it } from "vitest";
import { custodyMarks, displayId } from "@/lib/files";
import { createMockApi, MOCK_WORKSPACE_ID } from "@/lib/api/mock";
import type { Actor, FileSummary } from "@/lib/api/types";

const human: Actor = { actorType: "human", actorId: "u", actorName: "Demo Human" };

describe("displayId", () => {
  it("is a stable TDM-XXXX code derived from the file id", () => {
    expect(displayId("file_proposal")).toMatch(/^TDM-[0-9A-F]{4}$/);
    expect(displayId("file_proposal")).toBe(displayId("file_proposal"));
    expect(displayId("file_proposal")).not.toBe(displayId("file_brief"));
  });
});

describe("custodyMarks", () => {
  const base: FileSummary = {
    id: "f",
    workspaceId: "ws",
    parentId: null,
    name: "a.md",
    mimeType: "text/markdown",
    version: 3,
    updatedAt: 0,
    updatedBy: { actorType: "agent", actorId: "c" },
  };

  it("uses the backend's custody list when present, head last", () => {
    expect(custodyMarks({ ...base, custody: ["agent", "human", "agent"] })).toEqual([
      { kind: "agent", head: false },
      { kind: "human", head: false },
      { kind: "agent", head: true },
    ]);
  });

  it("falls back to neutral marks for earlier versions, never guessing their actors", () => {
    expect(custodyMarks(base)).toEqual([
      { kind: "unknown", head: false },
      { kind: "unknown", head: false },
      { kind: "agent", head: true },
    ]);
  });

  it("caps the strip at 8 marks for long histories", () => {
    expect(custodyMarks({ ...base, version: 40 })).toHaveLength(8);
  });
});

describe("mock listFiles custody", () => {
  it("reports each version's actor type, oldest first", async () => {
    const api = createMockApi({ latencyMs: [0, 0], getActor: () => human });
    const brief = (await api.listFiles(MOCK_WORKSPACE_ID)).find((f) => f.name === "brief.md");
    expect(brief?.custody).toEqual(["agent", "human"]);
  });
});
