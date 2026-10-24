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

/**
 * Who a stash belongs to. `null` when no identity is known: never stash or
 * restore then, or anonymous sessions would share one bucket. Normalized so
 * `Alex@x.dev` and `alex@x.dev` are the same person.
 */
export function draftOwnerKey(email: string | null | undefined): string | null {
  const key = email?.trim().toLowerCase();
  return key ? key : null;
}

export function draftStashKey(userKey: string, fileId: string): string {
  return `${ownerPrefix(userKey)}${fileId}`;
}

// Dots escaped too, so "." only ever separates the owner from the file id.
function ownerPrefix(userKey: string): string {
  return `${PREFIX}${encodeURIComponent(userKey).replaceAll(".", "%2E")}.`;
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

function stashKeys(): string[] {
  try {
    return Object.keys(window.sessionStorage).filter((k) => k.startsWith(PREFIX));
  } catch {
    return []; // storage unavailable: nothing was stashed
  }
}

/** Files with unsaved drafts in this tab, so sign-out can warn before dropping them. */
export function countDraftStashes(): number {
  return stashKeys().length;
}

/** On an explicit sign-out: the user chose to leave, so don't keep drafts around. */
export function clearAllDraftStashes() {
  stashKeys().forEach((k) => writeStored(k, null, "session"));
}

/** After a sign-in: drop drafts a previous user left in this tab. */
export function clearOtherUsersDraftStashes(ownerKey: string) {
  const own = ownerPrefix(ownerKey);
  stashKeys()
    .filter((k) => !k.startsWith(own))
    .forEach((k) => writeStored(k, null, "session"));
}
