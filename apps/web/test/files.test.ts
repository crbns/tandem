import { describe, expect, it } from "vitest";
import { filterAndSortFiles, parseNewFileName, isTextMimeType } from "@/lib/files";
import { formatRelative } from "@/lib/time";
import type { FileSummary } from "@/lib/api/types";

const file = (name: string, updatedAt: number): FileSummary => ({
  id: name,
  workspaceId: "ws",
  parentId: null,
  name,
  mimeType: "text/markdown",
  version: 1,
  updatedAt,
  updatedBy: { actorType: "human", userId: "u" },
});

describe("filterAndSortFiles", () => {
  const files = [file("old.md", 1), file("Proposal.md", 3), file("notes.txt", 2)];

  it("sorts newest first", () => {
    expect(filterAndSortFiles(files, "").map((f) => f.name)).toEqual([
      "Proposal.md",
      "notes.txt",
      "old.md",
    ]);
  });

  it("filters by case-insensitive name substring, ignoring surrounding spaces", () => {
    expect(filterAndSortFiles(files, "  prop ").map((f) => f.name)).toEqual(["Proposal.md"]);
  });

  it("does not mutate its input", () => {
    filterAndSortFiles(files, "");
    expect(files.map((f) => f.name)).toEqual(["old.md", "Proposal.md", "notes.txt"]);
  });
});

describe("parseNewFileName", () => {
  it("defaults to .md and text/markdown", () => {
    expect(parseNewFileName("plan")).toEqual({ ok: true, name: "plan.md", mimeType: "text/markdown" });
  });

  it("uses text/plain for .txt", () => {
    expect(parseNewFileName("todo.txt")).toEqual({ ok: true, name: "todo.txt", mimeType: "text/plain" });
  });

  it("keeps an explicit .md and trims whitespace", () => {
    expect(parseNewFileName("  spec.md ")).toEqual({ ok: true, name: "spec.md", mimeType: "text/markdown" });
  });

  it("rejects empty names and path separators", () => {
    expect(parseNewFileName("   ").ok).toBe(false);
    expect(parseNewFileName("a/b.md").ok).toBe(false);
    expect(parseNewFileName(".md").ok).toBe(false);
  });

  it("rejects extensions the editor can't handle", () => {
    expect(parseNewFileName("deck.pptx").ok).toBe(false);
  });
});

describe("isTextMimeType", () => {
  it("accepts markdown and plain text, rejects binaries", () => {
    expect(isTextMimeType("text/markdown")).toBe(true);
    expect(isTextMimeType("text/plain")).toBe(true);
    expect(isTextMimeType("application/pdf")).toBe(false);
  });
});

describe("formatRelative", () => {
  const now = 1_000_000_000_000;
  it.each([
    [now - 10_000, "just now"],
    [now - 3 * 60_000, "3 min ago"],
    [now - 2 * 3_600_000, "2 h ago"],
    [now - 26 * 3_600_000, "yesterday"],
    [now - 4 * 86_400_000, "4 days ago"],
  ])("formats %d", (ts, expected) => {
    expect(formatRelative(ts, now)).toBe(expected);
  });
});
