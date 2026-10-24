"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { beginSignOut } from "./signOutIntent";
import { clearAllDraftStashes } from "../editor/draftStash";
import { writeStored } from "../storage";

// Drafts live in per-tab sessionStorage, so an explicit sign-out pings the
// other tabs through localStorage (whose "storage" event only fires there).
const SIGN_OUT_SIGNAL_KEY = "tandem.signout";

/** Explicit sign-out: drop local drafts, end the session, go to sign-in (no `next`). */
export async function signOutAndLeave(signOut: () => Promise<void>, goToSignIn: () => void) {
  beginSignOut();
  clearAllDraftStashes();
  writeStored(SIGN_OUT_SIGNAL_KEY, String(Date.now()));
  try {
    await signOut();
  } catch {
    toast.error("Couldn't reach Tandem to sign out. You've been signed out on this device.");
  } finally {
    goToSignIn();
  }
}

/** Mount once per tab: clears this tab's drafts when another tab signs out. */
export function useClearDraftsOnSignOutElsewhere() {
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === SIGN_OUT_SIGNAL_KEY && e.newValue) clearAllDraftStashes();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
}
