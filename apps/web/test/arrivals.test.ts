import { describe, expect, it } from "vitest";
import { arrivalMessage, detectArrivals } from "@/lib/arrivals";
import type { Actor, FileSummary } from "@/lib/api/types";

const alexsClaude: Actor = { actorType: "agent", userId: "u_alex", userName: "Alex", agentClient: "claude" };
const blake: Actor = { actorType: "human", userId: "u_blake", userName: "Blake" };

function file(id: string, version: number, updatedBy: Actor, name = `${id}.md`): FileSummary {
  return { id, workspaceId: "w", parentId: null, name, mimeType: "text/markdown", version, updatedAt: 0, updatedBy };
}

describe("detectArrivals", () => {
  it("reports nothing on the first load, so opening the page doesn't flash every file", () => {
    expect(detectArrivals(null, [file("a", 1, alexsClaude)])).toEqual([]);
  });

  it("reports a file an assistant created and one it saved a new version of", () => {
    const before = [file("a", 1, blake)];
    const after = [file("a", 2, alexsClaude), file("b", 1, alexsClaude, "proposal.md")];
    expect(detectArrivals(before, after).map((a) => [a.file.id, a.kind])).toEqual([
      ["a", "updated"],
      ["b", "created"],
    ]);
  });

  it("reports a rename or move as moved, not saved, since content didn't change", () => {
    const before = [file("a", 1, blake, "proposal.md"), file("b", 1, blake, "notes.md")];
    const after = [
      { ...file("a", 2, alexsClaude, "proposal.md"), parentId: "folder_specs" },
      file("b", 2, alexsClaude, "meeting-notes.md"),
    ];
    expect(detectArrivals(before, after).map((a) => [a.file.id, a.kind])).toEqual([
      ["a", "moved"],
      ["b", "moved"],
    ]);
    expect(arrivalMessage(detectArrivals(before, after)[1]!)).toBe("Alex via Claude moved meeting-notes.md");
  });

  it("ignores human saves (the person saw their own edit) and unchanged files", () => {
    const before = [file("a", 1, alexsClaude)];
    const after = [file("a", 1, alexsClaude), file("c", 1, blake)];
    expect(detectArrivals(before, after)).toEqual([]);
  });
});

describe("arrivalMessage", () => {
  it("names the person and their assistant", () => {
    expect(arrivalMessage({ kind: "created", file: file("b", 1, alexsClaude, "proposal.md") })).toBe(
      "Alex via Claude created proposal.md",
    );
    expect(arrivalMessage({ kind: "updated", file: file("a", 3, alexsClaude, "brief.md") })).toBe(
      "Alex via Claude saved brief.md v3",
    );
  });
});
