"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { ARRIVAL_MS, arrivalMessage, detectArrivals, type ArrivalMark } from "@/lib/arrivals";
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
 * that arrived and when; file lists mark their rows.
 */
export const ArrivalsContext = createContext<ReadonlyMap<string, ArrivalMark>>(new Map());

export function useArrivedFiles(): ReadonlyMap<string, ArrivalMark> {
  return useContext(ArrivalsContext);
}

/**
 * Watches the workspace's file list for agent writes. Each one gets a toast
 * ("Alex via Claude created proposal.md", with Open) and stays in the
 * returned map for ARRIVAL_MS so its row can be marked. No toast for the
 * file already open: its editor reports the newer version itself.
 */
export function useArrivals(workspaceId: string, files: Resource<FileSummary[]>): ReadonlyMap<string, ArrivalMark> {
  const router = useRouter();
  const pathname = usePathname();
  const openPath = useRef(pathname);
  openPath.current = pathname;
  const previous = useRef<{ workspaceId: string; files: FileSummary[] } | null>(null);
  const [arrived, setArrived] = useState<ReadonlyMap<string, ArrivalMark>>(new Map());
  // One timer per file: a second save within ARRIVAL_MS restarts its mark
  // instead of the first save's timer clearing it early.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // Arrivals noticed while the tab was hidden (the presenter is in their chat
  // tab): marked when the tab is shown, so the 8s run while people can see it.
  // Sonner pauses the toasts' timers while hidden for the same reason.
  const held = useRef(new Map<string, number>());

  const mark = useCallback((entries: Array<[id: string, version: number]>) => {
    const at = Date.now();
    setArrived((current) => {
      const next = new Map(current);
      for (const [id, version] of entries) next.set(id, { version, at });
      return next;
    });
    for (const [id] of entries) {
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
    }
  }, []);

  useEffect(() => {
    const pending = timers.current;
    const onVisible = () => {
      if (document.hidden || held.current.size === 0) return;
      const entries = [...held.current];
      held.current.clear();
      mark(entries);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, [mark]);

  useEffect(() => {
    if (files.status !== "ready") return;
    const before = previous.current?.workspaceId === workspaceId ? previous.current.files : null;
    previous.current = { workspaceId, files: files.data };
    const arrivals = detectArrivals(before, files.data);
    if (arrivals.length === 0) return;
    const entries = arrivals.map((a): [string, number] => [a.file.id, a.file.version]);
    if (document.hidden) for (const [id, version] of entries) held.current.set(id, version);
    else mark(entries);
    for (const arrival of arrivals) {
      const { id } = arrival.file;
      const href = `/w/${workspaceId}/files/${id}`;
      if (openPath.current === href) continue;
      toast(arrivalMessage(arrival), {
        // One toast per file: a re-save updates it in place instead of stacking.
        id: `arrival-${id}`,
        // As long as the row stays marked, so it's still up when people look.
        duration: ARRIVAL_MS,
        action: { label: "Open", onClick: () => router.push(href) },
      });
    }
  }, [files, workspaceId, router, mark]);

  return arrived;
}
