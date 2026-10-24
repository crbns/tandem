"use client";

import { useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/auth/useSession";
import { useTandemApi } from "@/lib/api";
import { useResource } from "@/lib/api/useResource";
import { DEFAULT_WORKSPACE_ID } from "@/lib/config";
import { FullPageSpinner } from "@/components/common/FullPageSpinner";
import { ErrorState } from "@/components/common/ErrorState";
import { signOutAndLeave } from "@/lib/auth/signOutAndLeave";
import { Button } from "@/components/ui/button";

function WorkspaceRedirect() {
  const api = useTandemApi();
  const { signOut } = useSession();
  const router = useRouter();
  const load = useCallback(async () => {
    const workspaces = await api.listWorkspaces();
    // The configured default is a preference, not an override: only use it if
    // this user is actually a member.
    const preferred = workspaces.find((w) => w.id === DEFAULT_WORKSPACE_ID);
    return (preferred ?? workspaces[0])?.id ?? null;
  }, [api]);
  const { resource, refreshing, reload } = useResource(load);

  useEffect(() => {
    if (resource.status === "ready" && resource.data) router.replace(`/w/${resource.data}`);
  }, [resource, router]);

  if (resource.status === "error") {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <ErrorState error={resource.error} onRetry={reload} retrying={refreshing} className="max-w-md" />
      </div>
    );
  }
  if (resource.status === "ready" && !resource.data) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-4 text-center text-sm text-muted-foreground">
        <p>You&apos;re not a member of any workspace yet. Ask a teammate to invite you.</p>
        <Button variant="outline" size="sm" onClick={() => void signOutAndLeave(signOut, () => router.replace("/sign-in"))}>
          Sign in with a different account
        </Button>
      </div>
    );
  }
  return <FullPageSpinner label="Opening your workspace…" />;
}

export default function Home() {
  const { status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "unauthenticated") router.replace("/sign-in");
  }, [status, router]);

  if (status !== "authenticated") return <FullPageSpinner />;
  return <WorkspaceRedirect />;
}
