import { describe, expect, it } from "vitest";
import {
  canSave,
  draftToStash,
  initSaveState,
  saveReducer,
  type SaveEvent,
  type SaveState,
  type Theirs,
} from "@/lib/editor/saveMachine";
import { performSave } from "@/lib/editor/performSave";
import { createMockApi, MOCK_WORKSPACE_ID } from "@/lib/api/mock";
import type { Actor } from "@/lib/api/types";

const run = (state: SaveState, ...events: SaveEvent[]) => events.reduce(saveReducer, state);
const theirs: Theirs = {
  version: 3,
  content: "their text",
  updatedBy: { actorType: "agent", actorId: "agent_claude", actorName: "Claude" },
};

describe("saveReducer", () => {
  const initial = initSaveState("hello", 1);

  it("starts clean", () => {
    expect(initial).toEqual({ base: "hello", baseVersion: 1, draft: "hello", phase: { kind: "clean" } });
  });

  it("tracks dirty, and returns to clean when the draft matches the base again", () => {
    const dirty = run(initial, { type: "EDIT", draft: "hello!" });
    expect(dirty.phase.kind).toBe("dirty");
    expect(run(dirty, { type: "EDIT", draft: "hello" }).phase.kind).toBe("clean");
  });

  it("ignores SAVE when clean", () => {
    expect(run(initial, { type: "SAVE" })).toBe(initial);
  });

  it("save success bumps the base version and content", () => {
    const saved = run(
      initial,
      { type: "EDIT", draft: "v2" },
      { type: "SAVE" },
      { type: "SAVE_OK", version: 2, content: "v2" },
    );
    expect(saved).toEqual({ base: "v2", baseVersion: 2, draft: "v2", phase: { kind: "clean" } });
  });

  it("stays dirty if the user typed while the save was in flight", () => {
    const saved = run(
      initial,
      { type: "EDIT", draft: "v2" },
      { type: "SAVE" },
      { type: "EDIT", draft: "v2 and more" },
      { type: "SAVE_OK", version: 2, content: "v2" },
    );
    expect(saved.baseVersion).toBe(2);
    expect(saved.draft).toBe("v2 and more");
    expect(saved.phase.kind).toBe("dirty");
  });

  it("a conflict preserves mine and does not move the base", () => {
    const conflicted = run(
      initial,
      { type: "EDIT", draft: "my text" },
      { type: "SAVE" },
      { type: "SAVE_CONFLICT", theirs },
    );
    expect(conflicted.phase).toEqual({ kind: "conflict", mine: "my text", theirs });
    expect(conflicted.draft).toBe("my text");
    expect(conflicted.baseVersion).toBe(1);
  });

  it("never auto-retries: SAVE is ignored while in conflict", () => {
    const conflicted = run(initial, { type: "EDIT", draft: "my text" }, { type: "SAVE" }, { type: "SAVE_CONFLICT", theirs });
    expect(run(conflicted, { type: "SAVE" })).toBe(conflicted);
  });

  it("KEEP_MINE_REBASE sets the base to theirs and keeps the draft", () => {
    const rebased = run(
      initial,
      { type: "EDIT", draft: "my text" },
      { type: "SAVE" },
      { type: "SAVE_CONFLICT", theirs },
      { type: "KEEP_MINE_REBASE" },
    );
    expect(rebased).toEqual({ base: "their text", baseVersion: 3, draft: "my text", phase: { kind: "dirty" } });
    expect(canSave(rebased)).toBe(true);
  });

  it("RELOAD_THEIRS replaces the draft with the latest version", () => {
    const reloaded = run(
      initial,
      { type: "EDIT", draft: "my text" },
      { type: "SAVE" },
      { type: "SAVE_CONFLICT", theirs },
      { type: "RELOAD_THEIRS" },
    );
    expect(reloaded).toEqual({ base: "their text", baseVersion: 3, draft: "their text", phase: { kind: "clean" } });
  });

  it("an error keeps the draft; dismissing returns to dirty; saving again is allowed", () => {
    const errored = run(initial, { type: "EDIT", draft: "my text" }, { type: "SAVE" }, { type: "SAVE_ERROR", code: "NETWORK" });
    expect(errored.phase).toEqual({ kind: "error", code: "NETWORK" });
    expect(errored.draft).toBe("my text");
    expect(run(errored, { type: "DISMISS_ERROR" }).phase.kind).toBe("dirty");
    expect(run(errored, { type: "SAVE" }).phase.kind).toBe("saving");
  });

  it("ignores stray results when no save is in flight", () => {
    const dirty = run(initial, { type: "EDIT", draft: "x" });
    expect(run(dirty, { type: "SAVE_OK", version: 9, content: "x" })).toBe(dirty);
    expect(run(dirty, { type: "SAVE_CONFLICT", theirs })).toBe(dirty);
  });

  it("canSave only when dirty (or retrying after an error)", () => {
    expect(canSave(initial)).toBe(false);
    expect(canSave(run(initial, { type: "EDIT", draft: "x" }))).toBe(true);
    expect(canSave(run(initial, { type: "EDIT", draft: "x" }, { type: "SAVE" }))).toBe(false);
  });
});

describe("draftToStash", () => {
  const initial = initSaveState("hello", 1);

  it("stashes nothing when the draft matches the base", () => {
    expect(draftToStash(initial)).toBeNull();
  });

  it("stashes the live draft and base version while dirty or saving", () => {
    const typing = run(initial, { type: "EDIT", draft: "hi" }, { type: "SAVE" }, { type: "EDIT", draft: "hi there" });
    expect(draftToStash(typing)).toEqual({ draft: "hi there", baseVersion: 1 });
  });

  it("stashes mine during a conflict, keeping the old base so a restore conflicts again", () => {
    const conflicted = run(initial, { type: "EDIT", draft: "mine" }, { type: "SAVE" }, { type: "SAVE_CONFLICT", theirs });
    expect(draftToStash(conflicted)).toEqual({ draft: "mine", baseVersion: 1 });
  });
});

describe("performSave", () => {
  const human: Actor = { actorType: "human", actorId: "u", actorName: "Demo Human" };
  const claude: Actor = { actorType: "agent", actorId: "agent_claude", actorName: "Claude" };

  it("returns SAVE_OK with the new version", async () => {
    const api = createMockApi({ latencyMs: [0, 0], getActor: () => human });
    const { id } = await api.createFile(MOCK_WORKSPACE_ID, { name: "a.md", mimeType: "text/markdown" });
    expect(await performSave(api, id, 1, "new")).toEqual({ type: "SAVE_OK", version: 2, content: "new" });
  });

  it("returns SAVE_CONFLICT carrying the latest version, content, and author", async () => {
    const api = createMockApi({ latencyMs: [0, 0], getActor: () => human });
    const { id } = await api.createFile(MOCK_WORKSPACE_ID, { name: "a.md", mimeType: "text/markdown" });
    api.__simulateExternalEdit(id, "agent text", claude);
    expect(await performSave(api, id, 1, "mine")).toEqual({
      type: "SAVE_CONFLICT",
      theirs: { version: 2, content: "agent text", updatedBy: claude },
    });
  });

  it("refetches the latest version when the conflict error has no content", async () => {
    const api = createMockApi({ latencyMs: [0, 0], getActor: () => human });
    const { id } = await api.createFile(MOCK_WORKSPACE_ID, { name: "a.md", mimeType: "text/markdown" });
    api.__simulateExternalEdit(id, "agent text", claude);
    const { TandemApiError } = await import("@/lib/api/errors");
    const bare = {
      ...api,
      updateFileContent: () => Promise.reject(new TandemApiError("VERSION_CONFLICT", { currentVersion: 2 })),
    };
    const event = await performSave(bare, id, 1, "mine");
    expect(event).toEqual({
      type: "SAVE_CONFLICT",
      theirs: { version: 2, content: "agent text", updatedBy: claude },
    });
  });

  it("returns SAVE_ERROR with the normalized code for other failures", async () => {
    const api = createMockApi({ latencyMs: [0, 0], getActor: () => human });
    expect(await performSave(api, "missing", 1, "x")).toEqual({ type: "SAVE_ERROR", code: "FILE_NOT_FOUND" });
  });
});
