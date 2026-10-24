import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { restoreSaveState, saveReducer, type Theirs } from "@/lib/editor/saveMachine";
import {
  clearOtherUsersDraftStashes,
  countDraftStashes,
  draftOwnerKey,
  draftStashKey,
  readDraftStash,
  stashDraft,
} from "@/lib/editor/draftStash";
import { sideBySide } from "@/lib/editor/lineDiff";
import { normalizeError, TandemApiError } from "@/lib/api/errors";
import { call } from "@/lib/api/convex";

const head: Theirs = {
  version: 4,
  content: "v4 from Claude",
  updatedBy: { actorType: "agent", actorId: "agent_claude", actorName: "Claude" },
};

describe("restoreSaveState", () => {
  it("starts clean with no stash, or a stash that matches the head", () => {
    expect(restoreSaveState(head, null).phase.kind).toBe("clean");
    expect(restoreSaveState(head, { draft: head.content, baseVersion: 3 }).phase.kind).toBe("clean");
  });

  it("restores a draft on the current version as dirty", () => {
    const state = restoreSaveState(head, { draft: "mine", baseVersion: 4 });
    expect(state).toMatchObject({ base: head.content, baseVersion: 4, draft: "mine", phase: { kind: "dirty" } });
  });

  it("opens a draft from an older version straight into the conflict", () => {
    const state = restoreSaveState(head, { draft: "mine", baseVersion: 3 });
    expect(state.phase).toEqual({ kind: "conflict", mine: "mine", theirs: head });
    // Keeping my text then saves against the version I've now seen, not the stale one.
    expect(saveReducer(state, { type: "KEEP_MINE_REBASE" })).toMatchObject({
      base: head.content,
      baseVersion: 4,
      draft: "mine",
      phase: { kind: "dirty" },
    });
  });

  it("treats a stash ahead of the head (mock store reseeded) as a conflict too", () => {
    expect(restoreSaveState(head, { draft: "mine", baseVersion: 9 }).phase.kind).toBe("conflict");
  });
});

describe("draft stash ownership", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    const sessionStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    // Object.keys(sessionStorage) lists stored keys in a browser; mirror that.
    const proxied = new Proxy(sessionStorage, { ownKeys: () => [...store.keys()], getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }) });
    vi.stubGlobal("window", { sessionStorage: proxied, dispatchEvent: () => true });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("normalizes the owner and refuses an unknown identity", () => {
    expect(draftOwnerKey(" Alex@X.dev ")).toBe("alex@x.dev");
    expect(draftOwnerKey("")).toBeNull();
    expect(draftOwnerKey(undefined)).toBeNull();
  });

  it("keys never collide across owners whose emails share a dotted prefix", () => {
    expect(draftStashKey("a@b.c", "d.f1")).not.toBe(draftStashKey("a@b.c.d", "f1"));
  });

  it("drops other users' drafts after a sign-in and keeps the signer's own", () => {
    stashDraft("alex@x.dev", "f1", { draft: "alex", baseVersion: 1 });
    stashDraft("sam@x.dev", "f1", { draft: "sam", baseVersion: 1 });
    stashDraft("alex@x.dev.evil", "f1", { draft: "lookalike", baseVersion: 1 });
    expect(countDraftStashes()).toBe(3);

    clearOtherUsersDraftStashes("alex@x.dev");
    expect(readDraftStash("alex@x.dev", "f1")?.draft).toBe("alex");
    expect(readDraftStash("sam@x.dev", "f1")).toBeNull();
    expect(readDraftStash("alex@x.dev.evil", "f1")).toBeNull();
    expect(countDraftStashes()).toBe(1);
  });
});

describe("sideBySide end of file", () => {
  it("doesn't mark an unchanged last line as changed when the other side appends", () => {
    const { mine, theirs } = sideBySide("a\nb", "a\nb\nc");
    expect(mine).toEqual([
      { text: "a", changed: false },
      { text: "b", changed: false },
    ]);
    expect(theirs.filter((l) => l.changed).map((l) => l.text)).toEqual(["c"]);
  });
});

describe("backend error codes shared with MCP", () => {
  it.each(["APPROVAL_REQUIRED", "INVALID_INPUT"] as const)("maps %s instead of UNKNOWN", (code) => {
    expect(normalizeError(new ConvexError({ code })).code).toBe(code);
  });
});

describe("Convex call deadline", () => {
  afterEach(() => vi.useRealTimers());

  it("rejects with NETWORK when the client never answers (offline)", async () => {
    vi.useFakeTimers();
    const pending = call(() => new Promise<never>(() => {}), 1000);
    const assertion = expect(pending).rejects.toMatchObject({ code: "NETWORK" });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("passes results and backend errors through", async () => {
    await expect(call(async () => 42)).resolves.toBe(42);
    await expect(
      call(async () => {
        throw new ConvexError({ code: "FORBIDDEN" });
      }),
    ).rejects.toBeInstanceOf(TandemApiError);
  });
});
