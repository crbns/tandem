import type { ActorType, FileSummary, Folder } from "./api/types";

/**
 * Short, stable catalogue code for a file ("TDM-7F3A"). Derived from the file
 * id (FNV-1a), so it is an identifier, not a claim about creation order.
 */
export function displayId(fileId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < fileId.length; i++) {
    h ^= fileId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `TDM-${((h >>> 0) & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;
}

export interface CustodyMark {
  kind: ActorType | "unknown";
  head: boolean;
}

const MAX_MARKS = 8;

/**
 * One mark per recent version, head last. When the backend doesn't say who
 * saved earlier versions, they render as neutral marks rather than guesses.
 */
export function custodyMarks(file: Pick<FileSummary, "version" | "updatedBy" | "custody">): CustodyMark[] {
  const kinds: Array<ActorType | "unknown"> = file.custody?.length
    ? file.custody.slice(-MAX_MARKS)
    : [
        ...Array.from({ length: Math.min(file.version, MAX_MARKS) - 1 }, () => "unknown" as const),
        file.updatedBy.actorType,
      ];
  return kinds.map((kind, i) => ({ kind, head: i === kinds.length - 1 }));
}

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

/** Validates a folder name from the New folder and Rename dialogs. The backend enforces the same limits. */
export function parseNewFolderName(input: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = input.trim();
  if (!name) return { ok: false, error: "Enter a folder name." };
  if (/[\\/]/.test(name)) return { ok: false, error: "Folder names can't contain / or \\." };
  if (name.length > 255) return { ok: false, error: "Folder names can be at most 255 characters." };
  return { ok: true, name };
}

/** The folder `folderId` names, or null when it's absent, unknown or in another workspace. */
export function findFolder(folders: readonly Folder[], folderId: string | null | undefined): Folder | null {
  return (folderId && folders.find((f) => f.id === folderId)) || null;
}

/**
 * Ancestors of `folder`, top level first, ending with the folder itself.
 * Stops at a missing parent or a cycle, so bad data can't hang the page.
 */
export function folderPath(folders: readonly Folder[], folder: Folder | null): Folder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path: Folder[] = [];
  const seen = new Set<string>();
  for (let at = folder; at && !seen.has(at.id); at = at.parentId ? (byId.get(at.parentId) ?? null) : null) {
    seen.add(at.id);
    path.unshift(at);
  }
  return path;
}

const byName = (a: Folder, b: Folder) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });

/** Folders directly inside `parentId` (null = top level), by name, filtered like files. */
export function childFolders(folders: readonly Folder[], parentId: string | null, query = ""): Folder[] {
  const q = query.trim().toLowerCase();
  return folders.filter((f) => f.parentId === parentId && (!q || f.name.toLowerCase().includes(q))).sort(byName);
}

export interface FolderTreeEntry {
  folder: Folder;
  depth: number;
}

/**
 * Every folder depth-first by name, for an indented picker. A folder whose
 * parent isn't in the list is shown at the top level rather than dropped.
 */
export function folderTree(folders: readonly Folder[]): FolderTreeEntry[] {
  const ids = new Set(folders.map((f) => f.id));
  const parentOf = (f: Folder) => (f.parentId && ids.has(f.parentId) ? f.parentId : null);
  const out: FolderTreeEntry[] = [];
  const seen = new Set<string>();
  const visit = (parentId: string | null, depth: number) => {
    for (const folder of folders.filter((f) => parentOf(f) === parentId).sort(byName)) {
      if (seen.has(folder.id)) continue;
      seen.add(folder.id);
      out.push({ folder, depth });
      visit(folder.id, depth + 1);
    }
  };
  visit(null, 0);
  return out;
}

/**
 * The folder and every folder under it: the destinations a move of `folderId`
 * would turn into a cycle. Stops at cycles in bad data.
 */
export function folderSubtree(folders: readonly Folder[], folderId: string): Set<string> {
  const subtree = new Set([folderId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of folders) {
      if (f.parentId && subtree.has(f.parentId) && !subtree.has(f.id)) {
        subtree.add(f.id);
        grew = true;
      }
    }
  }
  return subtree;
}

/** The register URL for a folder (null = top level). */
export function folderHref(workspaceId: string, folderId: string | null): string {
  return folderId ? `/w/${workspaceId}?folder=${encodeURIComponent(folderId)}` : `/w/${workspaceId}`;
}
