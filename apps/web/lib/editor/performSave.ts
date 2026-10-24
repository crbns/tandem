import { normalizeError } from "../api/errors";
import type { TandemApi } from "../api/tandemApi";
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
    if (err.code !== "VERSION_CONFLICT") return { type: "SAVE_ERROR", code: err.code };

    const { currentVersion, currentContent, updatedBy } = err.details;
    if (currentVersion !== undefined && currentContent !== undefined) {
      return {
        type: "SAVE_CONFLICT",
        theirs: { version: currentVersion, content: currentContent, ...(updatedBy ? { updatedBy } : {}) },
      };
    }

    try {
      const latest = await api.readFile(fileId);
      return {
        type: "SAVE_CONFLICT",
        theirs: { version: latest.version, content: latest.content ?? "", updatedBy: latest.updatedBy },
      };
    } catch (fetchErr) {
      return { type: "SAVE_ERROR", code: normalizeError(fetchErr).code };
    }
  }
}
