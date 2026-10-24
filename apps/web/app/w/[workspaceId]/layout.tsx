"use client";

import { useCallback, useEffect, type ReactNode } from "react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useSession } from "@/lib/auth/useSession";
import { isSigningOut } from "@/lib/auth/signOutIntent";
import { useTandemApi } from "@/lib/api";
import { useResource } from "@/lib/api/useResource";
import { ArrivalsContext, useArrivals, useWorkspaceRefresh, WorkspaceFilesContext } from "@/lib/api/useWorkspace";
import { AppShell } from "@/components/shell/AppShell";
import { FullPageSpinner } from "@/components/common/FullPageSpinner";

function WorkspaceShell({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const api = useTandemApi();
  const pathname = usePathname();
  const loadName = useCallback(async () => {
    const workspaces = await api.listWorkspaces();
    return workspaces.find((w) => w.id === workspaceId)?.name ?? "Workspace";
  }, [api, workspaceId]);
  const { resource, reload } = useResource(loadName);
  const loadFiles = useCallback(() => api.listFiles(workspaceId), [api, workspaceId]);
  const files = useResource(loadFiles);
  const { reload: reloadFiles } = files;
  // Navigation (e.g. after creating a file) refreshes the rail's count.
  useEffect(() => {
    reload();
    reloadFiles();
  }, [pathname, reload, reloadFiles]);
  // The name is cosmetic: a failed lookup falls back instead of blocking the app.
  // An assistant's save through MCP refreshes the list, which is how arrivals are noticed.
  useWorkspaceRefresh(workspaceId, reloadFiles);
  const arrived = useArrivals(workspaceId, files.resource);
  const name = resource.status === "ready" ? resource.data : "Workspace";
  // The count is decoration too; a failed listing just hides it.
  const fileCount = files.resource.status === "ready" ? files.resource.data.length : null;

  return (
    <WorkspaceFilesContext.Provider value={files}>
      <ArrivalsContext.Provider value={arrived}>
        <AppShell workspaceId={workspaceId} workspaceName={name} fileCount={fileCount}>
          {children}
        </AppShell>
      </ArrivalsContext.Provider>
    </WorkspaceFilesContext.Provider>
  );
}

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { status } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  // The proxy guards /w/* server-side in real mode; this also covers mock mode
  // and a session that expires while the tab is open.
  // An explicit sign-out navigates on its own (without `next`).
  useEffect(() => {
    if (status === "unauthenticated" && !isSigningOut()) {
      router.replace(`/sign-in?next=${encodeURIComponent(pathname)}`);
    }
  }, [status, pathname, router]);

  if (status !== "authenticated") return <FullPageSpinner />;
  return <WorkspaceShell workspaceId={workspaceId}>{children}</WorkspaceShell>;
}
