import type { ApiErrorCode } from "../api/errors";
import type { Actor } from "../api/types";

// Pure save/conflict state machine for the editor. No React, no I/O.
// Invariants:
//  - the user's draft is never discarded except by an explicit RELOAD_THEIRS;
//  - nothing here ever retries a save on its own.

/** The head version on the server when our save was rejected. */
export interface Theirs {
  version: number;
  content: string;
  updatedBy?: Actor;
}

export type SavePhase =
  | { kind: "clean" }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "conflict"; mine: string; theirs: Theirs }
  | { kind: "error"; code: ApiErrorCode };

export interface SaveState {
  /** Content of `baseVersion`; what the draft is compared against. */
  base: string;
  /** Sent as `expectedVersion` on the next save. */
  baseVersion: number;
  draft: string;
  phase: SavePhase;
}

export type SaveEvent =
  | { type: "EDIT"; draft: string }
  | { type: "SAVE" }
  | { type: "SAVE_OK"; version: number; content: string }
  | { type: "SAVE_CONFLICT"; theirs: Theirs }
  | { type: "SAVE_ERROR"; code: ApiErrorCode }
  | { type: "RELOAD_THEIRS" }
  | { type: "KEEP_MINE_REBASE" }
  | { type: "DISMISS_ERROR" }
  /** User explicitly throws away their unsaved edits (after confirming). */
  | { type: "DISCARD_DRAFT" };

export function initSaveState(content: string, version: number): SaveState {
  return { base: content, baseVersion: version, draft: content, phase: { kind: "clean" } };
}

const settled = (base: string, draft: string): SavePhase =>
  draft === base ? { kind: "clean" } : { kind: "dirty" };

/**
 * What to persist so a forced sign-in or unmount can't lose work: the live
 * draft plus the version it's based on (kept old during a conflict, so a
 * restore conflicts again instead of overwriting). `null` = nothing unsaved.
 */
export function draftToStash(state: SaveState): { draft: string; baseVersion: number } | null {
  if (state.phase.kind !== "conflict" && state.draft === state.base) return null;
  return { draft: state.draft, baseVersion: state.baseVersion };
}

/**
 * Start from a stashed draft (lost session, navigation). If the file moved on
 * since the draft's base, open straight into the conflict so the user sees the
 * newer version now, instead of a stale version label and a surprise conflict
 * on the next save.
 */
export function restoreSaveState(
  head: Theirs,
  stash: { draft: string; baseVersion: number } | null,
): SaveState {
  const fresh = initSaveState(head.content, head.version);
  if (!stash || stash.draft === head.content) return fresh;
  if (stash.baseVersion !== head.version) {
    return {
      ...fresh,
      baseVersion: stash.baseVersion,
      draft: stash.draft,
      phase: { kind: "conflict", mine: stash.draft, theirs: head },
    };
  }
  return { ...fresh, draft: stash.draft, phase: { kind: "dirty" } };
}

export function canSave(state: SaveState): boolean {
  return (
    state.phase.kind === "dirty" || (state.phase.kind === "error" && state.draft !== state.base)
  );
}

export function saveReducer(state: SaveState, event: SaveEvent): SaveState {
  const { phase } = state;

  switch (event.type) {
    case "EDIT": {
      if (event.draft === state.draft) return state;
      if (phase.kind === "saving" || phase.kind === "error") {
        return { ...state, draft: event.draft };
      }
      if (phase.kind === "conflict") {
        return { ...state, draft: event.draft, phase: { ...phase, mine: event.draft } };
      }
      return { ...state, draft: event.draft, phase: settled(state.base, event.draft) };
    }

    case "SAVE":
      return canSave(state) ? { ...state, phase: { kind: "saving" } } : state;

    case "SAVE_OK":
      if (phase.kind !== "saving") return state;
      return {
        ...state,
        base: event.content,
        baseVersion: event.version,
        phase: settled(event.content, state.draft),
      };

    case "SAVE_CONFLICT":
      if (phase.kind !== "saving") return state;
      return { ...state, phase: { kind: "conflict", mine: state.draft, theirs: event.theirs } };

    case "SAVE_ERROR":
      if (phase.kind !== "saving") return state;
      return { ...state, phase: { kind: "error", code: event.code } };

    case "RELOAD_THEIRS":
      if (phase.kind !== "conflict") return state;
      return initSaveState(phase.theirs.content, phase.theirs.version);

    case "KEEP_MINE_REBASE": {
      if (phase.kind !== "conflict") return state;
      // The user has now seen `theirs`, so the next save may intentionally
      // replace it: move the base forward, keep their draft.
      const { content, version } = phase.theirs;
      return { base: content, baseVersion: version, draft: state.draft, phase: settled(content, state.draft) };
    }

    case "DISMISS_ERROR":
      if (phase.kind !== "error") return state;
      return { ...state, phase: settled(state.base, state.draft) };

    case "DISCARD_DRAFT":
      // Saving and conflict have their own exits; don't race an in-flight save.
      if (phase.kind !== "dirty" && phase.kind !== "error") return state;
      return initSaveState(state.base, state.baseVersion);
  }
}
