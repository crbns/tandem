import type { FileSummary } from "./api/types";

/** Newest first, filtered by a case-insensitive name substring. Pure. */
export function filterAndSortFiles(files: readonly FileSummary[], query: string): FileSummary[] {
  const q = query.trim().toLowerCase();
  return files
    .filter((f) => !q || f.name.toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * The backend authorizes by the file's own workspace, so a file id pasted under
 * another workspace's URL would still load. Treat that as not found rather than
 * rendering workspace B's file inside workspace A's shell.
 */
export function belongsToWorkspace(file: Pick<FileSummary, "workspaceId">, workspaceId: string): boolean {
  return file.workspaceId === workspaceId;
}

const TEXT_EXTENSIONS: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
};

export function isTextMimeType(mimeType: string): boolean {
  return mimeType === "text/markdown" || mimeType === "text/plain";
}

export function isMarkdown(mimeType: string): boolean {
  return mimeType === "text/markdown";
}

export type ParsedFileName =
  | { ok: true; name: string; mimeType: string }
  | { ok: false; error: string };

/** Validates a name from the New file dialog. No extension → `.md`. */
export function parseNewFileName(input: string): ParsedFileName {
  const name = input.trim();
  if (!name) return { ok: false, error: "Enter a file name." };
  if (/[\\/]/.test(name)) return { ok: false, error: "File names can't contain / or \\." };

  const dot = name.lastIndexOf(".");
  if (dot === -1) return { ok: true, name: `${name}.md`, mimeType: "text/markdown" };
  if (dot === 0) return { ok: false, error: "Add a name before the extension." };

  const mimeType = TEXT_EXTENSIONS[name.slice(dot + 1).toLowerCase()];
  if (!mimeType) return { ok: false, error: "Only .md and .txt files can be created here." };
  return { ok: true, name, mimeType };
}
