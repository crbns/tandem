"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { ARRIVAL_MS, arrivalMessage, detectArrivals } from "@/lib/arrivals";
import { useTandemApi } from "./index";
import { useResource } from "./useResource";
import type { FileSummary, Workspace } from "./types";
import type { Resource } from "./useResource";

export type WorkspaceFiles = ReturnType<typeof useResource<FileSummary[]>>;

/** The workspace layout's file list (it backs the rail's count), shared so pages don't refetch it. */
export const WorkspaceFilesContext = createContext<WorkspaceFiles | null>(null);

export function useWorkspaceFiles(): WorkspaceFiles {
  const files = useContext(WorkspaceFilesContext);
  if (!files) throw new Error("useWorkspaceFiles must be used inside the workspace layout");
  return files;
}

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

/**
 * Files an assistant just created, saved or moved, by id, with the version
 * that arrived; the file table marks their rows.
 */
export const ArrivalsContext = createContext<ReadonlyMap<string, number>>(new Map());

export function useArrivedFiles(): ReadonlyMap<string, number> {
  return useContext(ArrivalsContext);
}

/**
 * Watches the workspace's file list for agent writes. Each one gets a toast
 * ("Alex via Claude created proposal.md", with Open) and stays in the
 * returned map for ARRIVAL_MS so its row can be marked. No toast for the
 * file already open: its editor reports the newer version itself.
 */
export function useArrivals(workspaceId: string, files: Resource<FileSummary[]>): ReadonlyMap<string, number> {
  const router = useRouter();
  const pathname = usePathname();
  const openPath = useRef(pathname);
  openPath.current = pathname;
  const previous = useRef<{ workspaceId: string; files: FileSummary[] } | null>(null);
  const [arrived, setArrived] = useState<ReadonlyMap<string, number>>(new Map());
  // One timer per file: a second save within ARRIVAL_MS restarts its mark
  // instead of the first save's timer clearing it early.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  useEffect(() => {
    if (files.status !== "ready") return;
    const before = previous.current?.workspaceId === workspaceId ? previous.current.files : null;
    previous.current = { workspaceId, files: files.data };
    const arrivals = detectArrivals(before, files.data);
    if (arrivals.length === 0) return;
    setArrived((current) => {
      const next = new Map(current);
      for (const { file } of arrivals) next.set(file.id, file.version);
      return next;
    });
    for (const arrival of arrivals) {
      const { id } = arrival.file;
      clearTimeout(timers.current.get(id));
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          setArrived((current) => {
            const next = new Map(current);
            next.delete(id);
            return next;
          });
        }, ARRIVAL_MS),
      );
      const href = `/w/${workspaceId}/files/${id}`;
      if (openPath.current === href) continue;
      toast(arrivalMessage(arrival), {
        id: `arrival-${id}-${arrival.file.version}`,
        action: { label: "Open", onClick: () => router.push(href) },
      });
    }
  }, [files, workspaceId, router]);

  return arrived;
}
