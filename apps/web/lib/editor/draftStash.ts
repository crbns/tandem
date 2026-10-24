"use client";

import { readStored, writeStored } from "../storage";

// Holds an unsaved draft across a forced sign-in (UNAUTHENTICATED on save).
// sessionStorage: scoped to this tab, gone when it closes.

interface StashedDraft {
  draft: string;
  baseVersion: number;
}

const keyFor = (fileId: string) => `tandem.draft.${fileId}`;

export function stashDraft(fileId: string, stash: StashedDraft) {
  writeStored(keyFor(fileId), JSON.stringify(stash), "session");
}

export function readDraftStash(fileId: string): StashedDraft | null {
  const raw = readStored(keyFor(fileId), "session");
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

export function clearDraftStash(fileId: string) {
  writeStored(keyFor(fileId), null, "session");
}
