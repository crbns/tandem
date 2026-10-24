import type { ApiErrorCode } from "./errors";

/** Copy for errors from creating a file, where the generic text talks about editing. */
export const CREATE_ERROR_COPY: Partial<Record<ApiErrorCode, string>> = {
  FORBIDDEN: "You can't create files in this workspace.",
};

/** User-facing copy for each error code. Components never show raw messages. */
export const ERROR_COPY: Record<ApiErrorCode, { title: string; description: string }> = {
  FORBIDDEN: {
    title: "You don't have access",
    description: "You're not a member of this workspace, or you can't edit this file.",
  },
  FILE_NOT_FOUND: {
    title: "File not found",
    description: "It may have been moved or deleted, or the link is wrong.",
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
