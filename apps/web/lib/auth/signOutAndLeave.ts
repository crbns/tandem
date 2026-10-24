"use client";

import { toast } from "sonner";
import { beginSignOut } from "./signOutIntent";
import { clearAllDraftStashes } from "../editor/draftStash";

/** Explicit sign-out: drop local drafts, end the session, go to sign-in (no `next`). */
export async function signOutAndLeave(signOut: () => Promise<void>, goToSignIn: () => void) {
  beginSignOut();
  clearAllDraftStashes();
  try {
    await signOut();
  } catch {
    toast.error("Couldn't reach Tandem to sign out. You've been signed out on this device.");
  } finally {
    goToSignIn();
  }
}
