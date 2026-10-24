"use client";

import { useCallback, useEffect } from "react";
import { useTandemApi } from "./index";
import { useResource } from "./useResource";
import type { Workspace } from "./types";

/** The signed-in person's role here; `undefined` while loading, `null` if unknown. */
export function useWorkspaceRole(workspaceId: string): Workspace["role"] | null | undefined {
  const api = useTandemApi();
  const load = useCallback(() => api.listWorkspaces(), [api]);
  const { resource } = useResource(load);
  if (resource.status === "loading") return undefined;
  if (resource.status === "error") return null;
  return resource.data.find((w) => w.id === workspaceId)?.role ?? null;
}

/**
 * Refetch when something lands in the workspace (an assistant's save through
 * MCP, a proposal, a decision) and when the window regains focus, so lists
 * stay current without a manual reload.
 */
export function useWorkspaceRefresh(workspaceId: string, reload: () => void) {
  const api = useTandemApi();
  useEffect(() => api.watchWorkspace(workspaceId, reload), [api, workspaceId, reload]);
  useEffect(() => {
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);
}
