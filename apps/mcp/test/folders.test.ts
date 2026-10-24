import { describe, expect, it } from "vitest";
import { MAX_FOLDER_DEPTH, folderPathResolver } from "../src/backend/folders.js";

describe("folderPathResolver", () => {
  it("builds top-down paths with a trailing slash, empty at the top level", () => {
    const pathOf = folderPathResolver([
      { id: "api", parent_id: "specs", name: "api" },
      { id: "specs", parent_id: null, name: "specs" },
    ]);
    expect(pathOf(null)).toBe("");
    expect(pathOf("specs")).toBe("specs/");
    expect(pathOf("api")).toBe("specs/api/");
  });

  it("stops at a folder it wasn't given and at MAX_FOLDER_DEPTH", () => {
    const orphan = folderPathResolver([{ id: "a", parent_id: "gone", name: "a" }]);
    expect(orphan("a")).toBe("a/");
    expect(orphan("gone")).toBe("");

    // A parent cycle can't loop forever.
    const cycle = folderPathResolver([
      { id: "x", parent_id: "y", name: "x" },
      { id: "y", parent_id: "x", name: "y" },
    ]);
    expect(cycle("x").split("/")).toHaveLength(MAX_FOLDER_DEPTH + 1);
  });
});
