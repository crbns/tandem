export type TandemErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "FILE_NOT_FOUND"
  | "VERSION_CONFLICT"
  | "NAME_EXISTS"
  | "INVALID_INPUT"
  | "INVALID_PATH"
  | "PATH_NOT_FOUND"
  | "FOLDER_NOT_FOUND"
  | "INVALID_MOVE"
  | "FOLDER_TOO_DEEP"
  | "FOLDER_TOO_LARGE";

/**
 * The tool that failed, so recovery hints name a next step it fits (mirrors
 * ErrorHint.tool in packages/backend/convex/lib/mcpContract.ts).
 */
export type FailedTool =
  | "update_document"
  | "create_document"
  | "create_folder"
  | "move_file"
  | "move_folder";

const isMove = (tool?: FailedTool) =>
  tool === "move_file" || tool === "move_folder";

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

export function invalidPath(path: string): TandemError {
  // Paths may contain untrusted names, so quote them.
  return new TandemError(
    "INVALID_PATH",
    `Invalid path ${JSON.stringify(path)}. Write paths like "/specs/api/endpoints.md": ` +
      `names separated by "/", without empty, "." or ".." segments.`,
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

export function folderTooDeep(): TandemError {
  return new TandemError(
    "FOLDER_TOO_DEEP",
    "Folders can nest at most 32 levels deep, and this would go deeper. Use a shallower folder.",
    { max_depth: 32 },
  );
}

/** Why a new name is invalid; reported as INVALID_INPUT with field "name". */
export function invalidName(
  reason: "slash" | "dot" | "length",
  tool?: FailedTool,
): TandemError {
  const why =
    reason === "slash"
      ? isMove(tool)
        ? 'it contains "/". new_name is only the name: pass the destination folder as to_folder_path (create it first with create_folder)'
        : 'it contains "/". To put a file in a folder, pass folder_path (create the folder first with create_folder)'
      : reason === "dot"
        ? 'it is "." or ".."'
        : tool === "create_folder"
          ? "a folder name in the path is longer than 255 characters"
          : "it is empty or longer than 255 characters";
  return new TandemError(
    "INVALID_INPUT",
    `Invalid name: ${why}. A name is 1–255 visible characters, without "/", and not "." or "..".`,
    { field: "name" },
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

export function invalidCursor(): TandemError {
  return new TandemError(
    "INVALID_INPUT",
    "cursor is invalid or for another workspace; call sync_workspace without since",
  );
}

export function nameExists(
  fileId: string,
  name: string,
  currentVersion: number,
  tool?: FailedTool,
): TandemError {
  // The name is untrusted workspace data, so quote it rather than splicing it into the sentence.
  return new TandemError(
    "NAME_EXISTS",
    `A file named ${JSON.stringify(name)} already exists (file_id ${fileId}, version ${currentVersion}). ` +
      (tool === "create_folder"
        ? `A folder can't share a name with a file in the same folder: choose a different folder path, or ask the user.`
        : isMove(tool)
          ? `Pass a different new_name or destination, or ask the user.`
          : `Read it with read_file. If it is the same document, merge your changes into it with update_document; ` +
            `otherwise choose a different name or ask the user.`),
    { kind: "file", file_id: fileId, name, current_version: currentVersion },
  );
}

/** A folder already uses the name in that folder (files and folders share one namespace). */
export function folderNameExists(
  folderId: string,
  name: string,
  tool?: FailedTool,
): TandemError {
  return new TandemError(
    "NAME_EXISTS",
    `A folder named ${JSON.stringify(name)} already exists there (folder_id ${folderId}). ` +
      (isMove(tool)
        ? `Pass a different new_name or destination, or ask the user.`
        : `Choose a different name, or use that folder.`),
    { kind: "folder", folder_id: folderId, name },
  );
}
