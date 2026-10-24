import { normalizeError } from "../api/errors";
import type { TandemApi } from "../api/tandemApi";
import type { FileDetail } from "../api/types";
import type { SaveEvent } from "./saveMachine";

/**
 * Runs one save and translates the outcome into a save-machine event.
 * On VERSION_CONFLICT it makes sure we have the latest content to show,
 * refetching the file when the backend's error didn't include it.
 */
export async function performSave(
  api: Pick<TandemApi, "updateFileContent" | "readFile">,
  fileId: string,
  expectedVersion: number,
  content: string,
): Promise<SaveEvent> {
  try {
    const { version } = await api.updateFileContent(fileId, { expectedVersion, content });
    return { type: "SAVE_OK", version, content };
  } catch (raw) {
    const err = normalizeError(raw);
    if (err.code === "UNKNOWN") return checkForHiddenConflict(api, fileId, expectedVersion);
    if (err.code !== "VERSION_CONFLICT") return { type: "SAVE_ERROR", code: err.code };

    const { currentVersion, currentContent, updatedBy } = err.details;
    if (currentVersion !== undefined && currentContent !== undefined) {
      return {
        type: "SAVE_CONFLICT",
        theirs: { version: currentVersion, content: currentContent, ...(updatedBy ? { updatedBy } : {}) },
      };
    }

    try {
      return conflictWith(await api.readFile(fileId));
    } catch (fetchErr) {
      return { type: "SAVE_ERROR", code: normalizeError(fetchErr).code };
    }
  }
}

function conflictWith(latest: FileDetail): SaveEvent {
  return {
    type: "SAVE_CONFLICT",
    theirs: { version: latest.version, content: latest.content ?? "", updatedBy: latest.updatedBy },
  };
}

/**
 * Deployed Convex redacts the message of any non-ConvexError, so a backend
 * that throws plain `Error("VERSION_CONFLICT…")` reaches us as UNKNOWN. Reread:
 * if the head moved past the version we edited, it was a conflict; show it
 * rather than "try again", which would fail the same way forever. Fails safe:
 * at worst an unrelated error shows the conflict screen, never an overwrite.
 */
async function checkForHiddenConflict(
  api: Pick<TandemApi, "readFile">,
  fileId: string,
  expectedVersion: number,
): Promise<SaveEvent> {
  try {
    const latest = await api.readFile(fileId);
    if (latest.version !== expectedVersion) return conflictWith(latest);
  } catch {
    // The reread failing tells us nothing new; report the original error.
  }
  return { type: "SAVE_ERROR", code: "UNKNOWN" };
}
