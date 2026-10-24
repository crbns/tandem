import type { ApiErrorCode } from "./errors";

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
  NETWORK: {
    title: "Can't reach Tandem",
    description: "Check your connection and try again. Nothing was lost.",
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
