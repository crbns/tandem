"use client";

import { useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/auth/useSession";
import { useTandemApi } from "@/lib/api";
import { useResource } from "@/lib/api/useResource";
import { DEFAULT_WORKSPACE_ID } from "@/lib/config";
import { FullPageSpinner } from "@/components/common/FullPageSpinner";
import { ErrorState } from "@/components/common/ErrorState";

function WorkspaceRedirect() {
  const api = useTandemApi();
  const router = useRouter();
  const load = useCallback(async () => {
    if (DEFAULT_WORKSPACE_ID) return DEFAULT_WORKSPACE_ID;
    const workspaces = await api.listWorkspaces();
    return workspaces[0]?.id ?? null;
  }, [api]);
  const { resource, reload } = useResource(load);

  useEffect(() => {
    if (resource.status === "ready" && resource.data) router.replace(`/w/${resource.data}`);
  }, [resource, router]);

  if (resource.status === "error") {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <ErrorState error={resource.error} onRetry={reload} className="max-w-md" />
      </div>
    );
  }
  if (resource.status === "ready" && !resource.data) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4 text-sm text-muted-foreground">
        You&apos;re not a member of any workspace yet. Ask a teammate to invite you.
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
