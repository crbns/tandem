import type { ApiErrorCode } from "./errors";

/** Copy for errors from creating a file, where the generic text talks about editing. */
export const CREATE_ERROR_COPY: Partial<Record<ApiErrorCode, string>> = {
  FORBIDDEN: "You can't create files in this workspace.",
  NAME_EXISTS: "A file with this name already exists here. Open it, or pick another name.",
};

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
};

/** User-facing copy for each error code. Components never show raw messages. */
export const ERROR_COPY: Record<ApiErrorCode, { title: string; description: string }> = {
  LIST_LIMIT_EXCEEDED: { title: "File list is too large", description: "Tandem can load up to 10,000 files across 100 pages at once. The server returned more pages than this view can load; no partial list is shown." },
  INVITE_INVALID: { title: "Invalid invite", description: "This invite link isn't valid. Ask a workspace admin for a new link." },
  INVITE_EXPIRED: { title: "Invite expired", description: "Invite links expire after seven days. Ask a workspace admin for a new link." },
  INVITE_USED: { title: "Invite already used", description: "Someone has already accepted this invite. Ask a workspace admin for a new link." },
  INVITE_REVOKED: { title: "Invite revoked", description: "A workspace admin revoked this invite. Ask for a new link." },
  FORBIDDEN: {
    title: "You don't have access",
    description: "You're not a member of this workspace, or you can't edit this file.",
  },
  FILE_NOT_FOUND: {
    title: "File not found",
    description: "It may have been moved or deleted, or the link is wrong.",
  },
  NAME_EXISTS: {
    title: "Name already taken",
    description: "A file with this name already exists in this folder. Names ignore case and surrounding spaces.",
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
