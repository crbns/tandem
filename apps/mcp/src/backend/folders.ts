/** Same cap as Convex's MAX_FOLDER_DEPTH (packages/backend/convex/lib/ops.ts). */
export const MAX_FOLDER_DEPTH = 64;

type FolderNode = { id: string; parent_id: string | null; name: string };

/**
 * Builds folder paths the way Convex's folderPaths does: folder names from the
 * top level down, each followed by "/" ("specs/api/"), "" for the top level.
 * The walk stops at a folder that isn't in `folders` and after
 * MAX_FOLDER_DEPTH folders, so a parent cycle can't loop.
 */
export function folderPathResolver(
  folders: Iterable<FolderNode>,
): (folderId: string | null) => string {
  const byId = new Map<string, FolderNode>();
  for (const f of folders) byId.set(f.id, f);
  const cache = new Map<string, string>();
  return (folderId) => {
    const chain: FolderNode[] = [];
    let prefix = "";
    for (let id = folderId; id !== null; ) {
      const cached = cache.get(id);
      if (cached !== undefined) {
        prefix = cached;
        break;
      }
      if (chain.length >= MAX_FOLDER_DEPTH) break;
      const folder = byId.get(id);
      if (!folder) break;
      chain.push(folder);
      id = folder.parent_id;
    }
    for (const folder of chain.reverse()) {
      prefix = `${prefix}${folder.name}/`;
      cache.set(folder.id, prefix);
    }
    return prefix;
  };
}
