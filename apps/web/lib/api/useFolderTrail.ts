"use client";

import { useCallback } from "react";
import { folderTrail } from "../folders";
import { useTandemApi } from "./index";
import type { TandemApi } from "./tandemApi";
import { useResource } from "./useResource";
import { useWorkspaceRefresh } from "./useWorkspace";

/** The folders holding a file, root first; empty at the workspace root. */
export async function loadFolderTrail(
  api: Pick<TandemApi, "listDirectory">,
  workspaceId: string,
  parentId: string | null,
): Promise<{ id: string; name: string }[]> {
  return parentId ? folderTrail(await api.listDirectory(workspaceId, parentId)) : [];
}

/**
 * The breadcrumb folders for a file page (pass `null` until the file has
 * loaded). Refetched when the file moves and on workspace events. Empty while
 * loading or if the trail can't be read, so the header still renders.
 */
export function useFolderTrail(workspaceId: string, parentId: string | null) {
  const api = useTandemApi();
  const load = useCallback(() => loadFolderTrail(api, workspaceId, parentId), [api, workspaceId, parentId]);
  const { resource, reload } = useResource(load);
  useWorkspaceRefresh(workspaceId, reload);
  return resource.status === "ready" ? resource.data : [];
}
