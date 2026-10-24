export type TandemErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "FILE_NOT_FOUND"
  | "VERSION_CONFLICT"
  | "NAME_EXISTS"
  | "APPROVAL_REQUIRED"
  | "INVALID_INPUT"
  | "INVALID_PATH"
  | "PATH_NOT_FOUND"
  | "FOLDER_NOT_FOUND"
  | "INVALID_MOVE"
  | "FOLDER_TOO_DEEP"
  | "FOLDER_TOO_LARGE";

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

export function folderNotFound(folderId: string): TandemError {
  return new TandemError(
    "FOLDER_NOT_FOUND",
    `No folder with id ${folderId}. Call list_files to find the correct folder id.`,
    { folder_id: folderId },
  );
}

export function invalidPath(path: string, reason: string): TandemError {
  return new TandemError(
    "INVALID_PATH",
    `Invalid path ${JSON.stringify(path)}: ${reason}. ` +
      `Write paths like "/specs/api/endpoints.md": names separated by "/", without empty, "." or ".." segments.`,
    { path },
  );
}

export function pathNotFound(path: string, hint: string): TandemError {
  // The path may contain untrusted names, so quote it.
  return new TandemError(
    "PATH_NOT_FOUND",
    `Nothing at path ${JSON.stringify(path)}. ${hint}`,
    { path },
  );
}

export function folderTooDeep(path: string): TandemError {
  return new TandemError(
    "FOLDER_TOO_DEEP",
    `Folders can nest at most 32 levels deep, and ${JSON.stringify(path)} would go deeper. Use a shallower folder.`,
    { path, max_depth: 32 },
  );
}

export function versionConflict(
  fileId: string,
  currentVersion: number,
  expectedVersion: number,
  tool: "update_document" | "move_file" = "update_document",
): TandemError {
  return new TandemError(
    "VERSION_CONFLICT",
    `File ${fileId} is at version ${currentVersion}, not ${expectedVersion}; someone else changed it. ` +
      (tool === "update_document"
        ? `Re-read the file with read_file, merge your changes into the latest content, `
        : `Re-read the file with read_file and check the move still makes sense, `) +
      `then retry ${tool} with expected_version=${currentVersion}.`,
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
    { kind: "file", file_id: fileId, name, current_version: currentVersion },
  );
}

/** A folder already uses the name in that folder (files and folders share one namespace). */
export function folderNameExists(folderId: string, name: string): TandemError {
  return new TandemError(
    "NAME_EXISTS",
    `A folder named ${JSON.stringify(name)} already exists there (folder_id ${folderId}). ` +
      `Choose a different name, or use that folder.`,
    { kind: "folder", folder_id: folderId, name },
  );
}
