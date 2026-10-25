import type { ApiErrorCode, TandemApiError } from "./errors";

/** Copy for errors from creating a file, where the generic text talks about editing. */
export const CREATE_ERROR_COPY: Partial<Record<ApiErrorCode, string>> = {
  FORBIDDEN: "You can't create files in this workspace.",
  NAME_EXISTS: "A file with this name already exists here. Open it, or pick another name.",
  FOLDER_NOT_FOUND: "This folder was moved or deleted. Go back to the workspace root and try again.",
};

/** Copy for renaming, moving or deleting a folder, where conflicts are about the folder. */
export const FOLDER_ERROR_COPY: Partial<Record<ApiErrorCode, string>> = {
  VERSION_CONFLICT: "Someone changed this folder since you opened it. The list has been refreshed; try again.",
  FOLDER_NOT_FOUND: "This folder was moved or deleted. The list has been refreshed.",
};

/**
 * One sentence for an inline error. NAME_EXISTS says whether a file or a
 * folder holds the name; everything else uses `overrides`, then ERROR_COPY.
 */
export function describeError(error: TandemApiError, overrides: Partial<Record<ApiErrorCode, string>> = {}): string {
  const existing = error.details.existing;
  if (error.code === "NAME_EXISTS" && existing) {
    const what = existing.kind === "folder" ? "A folder" : "A file";
    const named = existing.name ? ` named “${existing.name}”` : " with this name";
    return `${what}${named} already exists here. Names ignore case and extra spaces; pick another.`;
  }
  return overrides[error.code] ?? ERROR_COPY[error.code].description;
}

/** Copy for deciding a proposal, where VERSION_CONFLICT means the context moved on. */
export const DECIDE_ERROR_COPY: Partial<Record<ApiErrorCode, { title: string; description: string }>> = {
  VERSION_CONFLICT: {
    title: "The context changed since this was proposed",
    description:
      "Someone approved a different change to this field first, so approving this one would overwrite it. It's now marked stale; ask for a fresh proposal based on the current value.",
  },
  FORBIDDEN: {
    title: "Only owners and admins can decide",
    description: "You can read proposals, but a workspace owner or admin has to approve or reject them.",
  },
  PROPOSAL_CHANGED: {
    title: "This proposal changed while you were looking",
    description:
      "A conflict check finished or the proposal was updated after you opened it. Nothing was decided; review the refreshed card and decide again.",
  },
  CONFLICT_CHECK_PENDING: {
    title: "The conflict check isn't done yet",
    description:
      "Tandem is still comparing this proposal with the approved context. Wait for the verdict, or check again if it seems stuck. You can reject it now.",
  },
  PROPOSAL_DECIDED: {
    title: "Someone already decided this",
    description: "Another owner or admin settled it first, so your choice wasn't applied. The list shows where it stands now.",
  },
};

/** User-facing copy for each error code. Components never show raw messages. */
export const ERROR_COPY: Record<ApiErrorCode, { title: string; description: string }> = {
  LIST_LIMIT_EXCEEDED: { title: "File list is too large", description: "Tandem can load up to 10,000 files across 100 pages at once. The server returned more pages than this view can load; no partial list is shown." },
  INVITE_INVALID: { title: "Invalid invite", description: "This invite code or link isn't valid. Check the six letters, or ask a workspace admin for a new invite." },
  INVITE_EXPIRED: { title: "Invite expired", description: "Invite codes and links expire after seven days. Ask a workspace admin for a new invite code or link." },
  INVITE_USED: { title: "Invite already used", description: "Someone has already used this invite code or link. Ask a workspace admin for a new one." },
  INVITE_REVOKED: { title: "Invite revoked", description: "A workspace admin revoked this invite code or link. Ask for a new one." },
  FORBIDDEN: {
    title: "You don't have access",
    description: "You're not a member of this workspace, or you can't edit this file.",
  },
  FILE_NOT_FOUND: {
    title: "File not found",
    description: "It may have been moved or deleted, or the link is wrong.",
  },
  FOLDER_NOT_FOUND: {
    title: "Folder not found",
    description: "It may have been moved or deleted, or the link is wrong. Go back to the workspace root to find your files.",
  },
  NAME_EXISTS: {
    title: "Name already taken",
    description: "A file or folder with this name already exists in this folder. Names ignore case and surrounding spaces.",
  },
  INVALID_NAME: {
    title: "That name won't work",
    description: "Names need 1 to 255 characters, can't contain “/”, and can't be “.” or “..”.",
  },
  INVALID_MOVE: {
    title: "Can't move a folder there",
    description: "A folder can't be moved into itself or into one of its own subfolders. Pick another destination.",
  },
  FOLDER_TOO_DEEP: {
    title: "Too many nested folders",
    description: "Folders can be nested at most 32 levels deep. Pick a destination closer to the workspace root.",
  },
  FOLDER_TOO_LARGE: {
    title: "Folder is too large to delete at once",
    description: "A folder holding more than 500 files and folders can't be deleted in one step. Nothing was deleted; delete some subfolders first.",
  },
  VERSION_CONFLICT: {
    title: "Someone saved a newer version",
    description: "Your changes are safe. Review the latest version before saving.",
  },
  UNAUTHENTICATED: {
    title: "You've been signed out",
    description: "Sign in again to continue. Your unsaved text is kept.",
  },
  APPROVAL_REQUIRED: {
    title: "Needs approval",
    description: "This change needs a workspace member's approval before it applies.",
  },
  PROPOSAL_DECIDED: {
    title: "Already decided",
    description: "Someone decided this proposal before you did, or it was withdrawn. The list shows where it stands now.",
  },
  PROPOSAL_CHANGED: {
    title: "Proposal changed",
    description: "It was updated after you opened it. Review the latest version and try again.",
  },
  CONFLICT_CHECK_PENDING: {
    title: "Still checking for conflicts",
    description: "Wait for the conflict check to finish before approving.",
  },
  ALREADY_IN_CONTEXT: {
    title: "Already in the context",
    description: "This exact entry is already approved, so there's nothing to add.",
  },
  REQUEST_EXPIRED: {
    title: "This request expired",
    description: "Connection requests last ten minutes and can be answered once. Start connecting again from your assistant.",
  },
  BINARY_FILE: {
    title: "Upload a new version",
    description: "This file needs a binary upload. Upload a replacement in the dashboard.",
  },
  INVALID_INPUT: {
    title: "That didn't work",
    description: "Something about the request isn't valid. Check the name and type, then try again.",
  },
  NETWORK: {
    title: "Can't reach Tandem",
    description:
      "Check your connection and try again. Nothing was lost. A save that was in progress may still go through once you're back online.",
  },
  NOT_IMPLEMENTED: {
    title: "Not available yet",
    description: "The backend doesn't support this action yet.",
  },
  UNKNOWN: {
    title: "Something went wrong",
    description: "Try again. If it keeps happening, reload the page.",
  },
};
