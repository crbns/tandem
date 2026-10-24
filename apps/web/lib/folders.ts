import type { DirectoryListing, FileSummary, FolderSummary } from "./api/types";

export const ROOT_LABEL = "Workspace root";

/** The directory browser for a folder; the root has no `?folder=` param. */
export function folderHref(workspaceId: string, folderId: string | null): string {
  return folderId ? `/w/${workspaceId}?folder=${encodeURIComponent(folderId)}` : `/w/${workspaceId}`;
}

export interface Crumb {
  label: string;
  href: string;
}

/**
 * Root first, ending with the current folder. Tolerates a backend whose
 * breadcrumbs stop at the parent: the current folder is appended when missing.
 */
export function folderTrail(listing: Pick<DirectoryListing, "folder" | "breadcrumbs">): { id: string; name: string }[] {
  const trail = listing.breadcrumbs.filter((crumb) => crumb.id);
  const { folder } = listing;
  if (folder && trail.at(-1)?.id !== folder.id) trail.push({ id: folder.id, name: folder.name });
  return trail;
}

/** "Workspace root > a > b" as links; the last item is the page you're on. */
export function crumbItems(workspaceId: string, trail: { id: string; name: string }[]): Crumb[] {
  return [
    { label: ROOT_LABEL, href: folderHref(workspaceId, null) },
    ...trail.map((folder) => ({ label: folder.name, href: folderHref(workspaceId, folder.id) })),
  ];
}

export interface MoveTarget {
  /** `null` is the workspace root. */
  id: string | null;
  name: string;
  path: string;
  /** Nesting level for indentation; the root is 0. */
  depth: number;
  disabled: boolean;
  reason?: "current" | "inside";
}

/**
 * Destinations for Move…: the root, then every folder in path order. The
 * item's current folder is disabled (nothing to do), and so are a folder
 * itself and its descendants (the backend would reject them with INVALID_MOVE).
 */
export function moveTargets(
  tree: readonly FolderSummary[],
  item: { kind: "file" | "folder"; id: string; parentId: string | null },
): MoveTarget[] {
  const byId = new Map(tree.map((folder) => [folder.id, folder]));
  const isInside = (folderId: string) => {
    if (item.kind !== "folder") return false;
    const seen = new Set<string>();
    for (let id: string | null = folderId; id !== null && !seen.has(id); id = byId.get(id)?.parentId ?? null) {
      if (id === item.id) return true;
      seen.add(id);
    }
    return false;
  };
  const target = (id: string | null, name: string, path: string, depth: number): MoveTarget => {
    const reason = id !== null && isInside(id) ? "inside" : id === item.parentId ? "current" : undefined;
    return { id, name, path, depth, disabled: reason !== undefined, ...(reason ? { reason } : {}) };
  };
  return [
    target(null, ROOT_LABEL, "/", 0),
    ...treeOrder(tree).map(({ folder, depth }) => target(folder.id, folder.name, folder.path, depth)),
  ];
}

/**
 * Depth-first from the root, siblings by name, so every folder sits directly
 * under its parent. Sorting path strings can't do this: "/specs v2" and
 * "/specs-old" collate between "/specs" and "/specs/api".
 */
export function treeOrder(tree: readonly FolderSummary[]): { folder: FolderSummary; depth: number }[] {
  const ids = new Set(tree.map((folder) => folder.id));
  const children = new Map<string | null, FolderSummary[]>();
  for (const folder of tree) {
    // A parent missing from the tree (shouldn't happen) lists the folder at the root.
    const parent = folder.parentId !== null && ids.has(folder.parentId) ? folder.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), folder]);
  }
  const out: { folder: FolderSummary; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null, depth: number) => {
    const siblings = [...(children.get(parentId) ?? [])].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    for (const folder of siblings) {
      if (seen.has(folder.id)) continue;
      seen.add(folder.id);
      out.push({ folder, depth });
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 1);
  return out;
}

/** What deleting a folder removes: the folder, its subfolders and every file in them. */
export function subtreeCounts(
  folderId: string,
  tree: readonly FolderSummary[],
  files: readonly Pick<FileSummary, "parentId">[],
): { folders: number; files: number } {
  const ids = new Set([folderId]);
  // Parents can appear after their children, so repeat until nothing is added.
  for (let grew = true; grew; ) {
    grew = false;
    for (const folder of tree) {
      if (folder.parentId !== null && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id);
        grew = true;
      }
    }
  }
  return { folders: ids.size, files: files.filter((file) => file.parentId !== null && ids.has(file.parentId)).length };
}

/** "2 folders and 3 files" (singulars as needed). */
export function describeCounts({ folders, files }: { folders: number; files: number }): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return `${plural(folders, "folder")} and ${plural(files, "file")}`;
}
