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
  const loadName = useCallback(async () => {
    const workspaces = await api.listWorkspaces();
    return workspaces.find((w) => w.id === workspaceId)?.name ?? "Workspace";
  }, [api, workspaceId]);
  const { resource } = useResource(loadName);
  // The name is cosmetic: a failed lookup falls back instead of blocking the app.
  const name = resource.status === "ready" ? resource.data : "Workspace";

  return (
    <AppShell workspaceId={workspaceId} workspaceName={name}>
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
