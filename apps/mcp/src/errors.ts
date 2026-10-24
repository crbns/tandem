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

export function folderNameExists(folderId: string, name: string): TandemError {
  return new TandemError(
    "NAME_EXISTS",
    `A folder named ${JSON.stringify(name)} already exists here (folder_id ${folderId}). ` +
      `Use that folder, or choose a different name.`,
    { folder_id: folderId, name },
  );
}

/** A move that would clash with a file already in the destination folder. */
export function moveNameExists(
  fileId: string,
  name: string,
  currentVersion: number,
): TandemError {
  return new TandemError(
    "NAME_EXISTS",
    `The destination already has a file named ${JSON.stringify(name)} (file_id ${fileId}, version ${currentVersion}). ` +
      `Nothing was moved. Choose another folder or ask the user how to resolve the clash.`,
    { file_id: fileId, name, current_version: currentVersion },
  );
}

/** A move based on a stale read. Same code and details as versionConflict. */
export function moveConflict(
  fileId: string,
  currentVersion: number,
  expectedVersion: number,
): TandemError {
  return new TandemError(
    "VERSION_CONFLICT",
    `File ${fileId} is at version ${currentVersion}, not ${expectedVersion}; someone else changed it. ` +
      `Nothing was moved. Re-read the file with read_file, check the move still makes sense, ` +
      `then retry move_file with expected_version=${currentVersion}.`,
    {
      file_id: fileId,
      current_version: currentVersion,
      expected_version: expectedVersion,
    },
  );
}

/** parent_id isn't a folder in the workspace (malformed, missing, or another tenant's). */
export function invalidParentFolder(forMove = false): TandemError {
  return new TandemError(
    "INVALID_INPUT",
    forMove
      ? "parent_id must be a folder in this file's workspace (from list_folders), or null for the top level."
      : "parent_id must be a folder in this workspace (from list_folders); omit it to create at the top level.",
  );
}

/** list_files folder_id isn't a folder in the workspace. */
export function invalidFolderFilter(): TandemError {
  return new TandemError(
    "INVALID_INPUT",
    "folder_id must be a folder in this workspace (from list_folders); omit it to list every file.",
  );
}
