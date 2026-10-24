export type TandemErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "FILE_NOT_FOUND"
  | "VERSION_CONFLICT"
  | "APPROVAL_REQUIRED"
  | "INVALID_INPUT";

/** A domain error that tool handlers turn into an `isError` tool result. */
export class TandemError extends Error {
  constructor(
    readonly code: TandemErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "TandemError";
  }
}

export function forbidden(workspaceId: string): TandemError {
  return new TandemError(
    "FORBIDDEN",
    `You are not a member of workspace ${workspaceId}. Call list_files without workspace_id to use your default workspace.`,
    { workspace_id: workspaceId },
  );
}

export function fileNotFound(fileId: string): TandemError {
  return new TandemError(
    "FILE_NOT_FOUND",
    `No file with id ${fileId}. Call list_files to find the correct file_id.`,
    { file_id: fileId },
  );
}

export function versionConflict(
  fileId: string,
  currentVersion: number,
  expectedVersion: number,
): TandemError {
  return new TandemError(
    "VERSION_CONFLICT",
    `File ${fileId} is at version ${currentVersion}, not ${expectedVersion}; someone else changed it. ` +
      `Re-read the file with read_file, merge your changes into the latest content, ` +
      `then retry update_document with expected_version=${currentVersion}.`,
    {
      file_id: fileId,
      current_version: currentVersion,
      expected_version: expectedVersion,
    },
  );
}
