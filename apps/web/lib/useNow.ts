"use client";

import { useSyncExternalStore } from "react";

// One shared ticking clock so relative times ("3 min ago") stay fresh without
// calling Date.now() during render.
let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  now = Date.now();
  timer ??= setInterval(() => {
    now = Date.now();
    listeners.forEach((l) => l());
  }, 30_000);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function useNow(): number {
  return useSyncExternalStore(
    subscribe,
    () => now,
    () => now,
  );
}
