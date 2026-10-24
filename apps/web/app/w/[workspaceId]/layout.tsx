"use client";

import { useCallback, useEffect, type ReactNode } from "react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useSession } from "@/lib/auth/useSession";
import { isSigningOut } from "@/lib/auth/signOutIntent";
import { useTandemApi } from "@/lib/api";
import { useResource } from "@/lib/api/useResource";
import { AppShell } from "@/components/shell/AppShell";
import { FullPageSpinner } from "@/components/common/FullPageSpinner";

function WorkspaceShell({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const api = useTandemApi();
  const pathname = usePathname();
  const loadShell = useCallback(async () => {
    const [workspaces, fileCount] = await Promise.all([
      api.listWorkspaces(),
      api.listFiles(workspaceId).then(
        (files) => files.length,
        () => null, // the count is decoration; never block the shell on it
      ),
    ]);
    return { name: workspaces.find((w) => w.id === workspaceId)?.name ?? "Workspace", fileCount };
  }, [api, workspaceId]);
  const { resource, reload } = useResource(loadShell);
  // Navigation (e.g. after creating a file) refreshes the rail's count.
  useEffect(() => reload(), [pathname, reload]);
  // The name is cosmetic: a failed lookup falls back instead of blocking the app.
  const name = resource.status === "ready" ? resource.data.name : "Workspace";
  const fileCount = resource.status === "ready" ? resource.data.fileCount : null;

  return (
    <AppShell workspaceId={workspaceId} workspaceName={name} fileCount={fileCount}>
      {children}
    </AppShell>
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
