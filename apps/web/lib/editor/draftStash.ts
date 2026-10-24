"use client";

import { readStored, writeStored } from "../storage";

// Holds unsaved drafts so a lost session, forced sign-in, or navigation can't
// drop them. sessionStorage: scoped to this tab, gone when it closes. Keyed by
// user as well as file, so a different person signing in on the same tab never
// gets someone else's draft.

interface StashedDraft {
  draft: string;
  baseVersion: number;
}

const PREFIX = "tandem.draft.";

export function draftStashKey(userKey: string, fileId: string): string {
  return `${PREFIX}${encodeURIComponent(userKey)}.${fileId}`;
}

export function stashDraft(userKey: string, fileId: string, stash: StashedDraft) {
  writeStored(draftStashKey(userKey, fileId), JSON.stringify(stash), "session");
}

export function readDraftStash(userKey: string, fileId: string): StashedDraft | null {
  const raw = readStored(draftStashKey(userKey, fileId), "session");
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      value &&
      typeof value === "object" &&
      "draft" in value &&
      "baseVersion" in value &&
      typeof value.draft === "string" &&
      typeof value.baseVersion === "number"
    ) {
      return { draft: value.draft, baseVersion: value.baseVersion };
    }
  } catch {
    // ignore corrupt stash
  }
  return null;
}

export function clearDraftStash(userKey: string, fileId: string) {
  writeStored(draftStashKey(userKey, fileId), null, "session");
}

/** On an explicit sign-out: the user chose to leave, so don't keep drafts around. */
export function clearAllDraftStashes() {
  try {
    const keys = Object.keys(window.sessionStorage).filter((k) => k.startsWith(PREFIX));
    keys.forEach((k) => window.sessionStorage.removeItem(k));
  } catch {
    // storage unavailable: nothing was stashed
  }
}
