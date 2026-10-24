"use client";

import { useSyncExternalStore } from "react";

type StorageKind = "local" | "session";

// Same-tab writes don't fire the native "storage" event, so we raise our own.
const CHANGE_EVENT = "tandem-storage-change";

function storageFor(kind: StorageKind): Storage | null {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readStored(key: string, kind: StorageKind = "local"): string | null {
  try {
    return storageFor(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string | null, kind: StorageKind = "local") {
  try {
    const storage = storageFor(kind);
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, value);
  } catch {
    // Private mode / blocked storage: the app still works, it just forgets.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

/**
 * Reads a storage key reactively. Returns `undefined` during SSR and the
 * hydration render, so callers can treat "not hydrated yet" as loading
 * instead of mistaking it for "no value".
 */
export function useStoredValue(
  key: string,
  kind: StorageKind = "local",
): string | null | undefined {
  return useSyncExternalStore(
    subscribe,
    () => readStored(key, kind),
    () => undefined,
  );
}
