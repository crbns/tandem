export type TandemErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "FILE_NOT_FOUND"
  | "VERSION_CONFLICT"
  | "NAME_EXISTS"
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
    `You don't have access to workspace ${workspaceId}.`,
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

export function versionAhead(
  fileId: string,
  currentVersion: number,
  expectedVersion: number,
): TandemError {
  return new TandemError(
    "INVALID_INPUT",
    `expected_version ${expectedVersion} is newer than the file's current version ${currentVersion}. ` +
      `Use the file.version returned by read_file.`,
    {
      file_id: fileId,
      current_version: currentVersion,
      expected_version: expectedVersion,
    },
  );
}

export function invalidCursor(): TandemError {
  return new TandemError(
    "INVALID_INPUT",
    "cursor is invalid or for another workspace; call sync_workspace without since",
  );
}

export function approvalRequired(field: string): TandemError {
  return new TandemError(
    "APPROVAL_REQUIRED",
    "Changes to goal, scope, decisions or ownership need human approval. Use propose_context_change.",
    { field },
  );
}

export function nameExists(
  fileId: string,
  name: string,
  currentVersion: number,
): TandemError {
  // The name is untrusted workspace data, so quote it rather than splicing it into the sentence.
  return new TandemError(
    "NAME_EXISTS",
    `A file named ${JSON.stringify(name)} already exists (file_id ${fileId}, version ${currentVersion}). ` +
      `Read it with read_file. If it is the same document, merge your changes into it with update_document; ` +
      `otherwise choose a different name or ask the user.`,
    { file_id: fileId, name, current_version: currentVersion },
  );
}
