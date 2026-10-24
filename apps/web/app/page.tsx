"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon } from "lucide-react";
import { useSession } from "@/lib/auth/useSession";
import { normalizeError, useTandemApi } from "@/lib/api";
import { useResource } from "@/lib/api/useResource";
import { DEFAULT_WORKSPACE_ID } from "@/lib/config";
import { FullPageSpinner } from "@/components/common/FullPageSpinner";
import { ErrorState } from "@/components/common/ErrorState";
import { signOutAndLeave } from "@/lib/auth/signOutAndLeave";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ERROR_COPY } from "@/lib/api/errorCopy";

function WorkspaceRedirect() {
  const api = useTandemApi();
  const { signOut } = useSession();
  const router = useRouter();
  const [workspaceName, setWorkspaceName] = useState("");
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const workspaces = await api.listWorkspaces();
    // The configured default is a preference, not an override: only use it if
    // this user is actually a member.
    const preferred = workspaces.find((w) => w.id === DEFAULT_WORKSPACE_ID);
    return (preferred ?? workspaces[0])?.id ?? null;
  }, [api]);
  const { resource, refreshing, reload } = useResource(load);

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreatingWorkspace(true);
    setCreateError(null);
    try {
      const workspaceId = await api.createWorkspace(workspaceName);
      router.replace(`/w/${workspaceId}/overview`);
    } catch (error) {
      const { code } = normalizeError(error);
      setCreateError(ERROR_COPY[code].description);
      setCreatingWorkspace(false);
    }
  }

  useEffect(() => {
    if (resource.status === "ready" && resource.data)
      // Overview first: assistants, files and approved context on one screen.
      router.replace(`/w/${resource.data}/overview`);
  }, [resource, router]);

  if (resource.status === "error") {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <ErrorState
          error={resource.error}
          onRetry={reload}
          retrying={refreshing}
          className="max-w-md"
        />
      </div>
    );
  }
  if (resource.status === "ready" && !resource.data) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-5 px-4 text-sm text-muted-foreground">
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold text-foreground">
            No workspace yet
          </h1>
          <p className="mt-1">
            Create a workspace to get started, or ask a teammate to invite you.
          </p>
        </div>
        <form
          onSubmit={createWorkspace}
          className="grid w-full max-w-sm gap-3 rounded-md border bg-card p-4"
        >
          <div className="grid gap-2">
            <Label htmlFor="workspace-name">Workspace name</Label>
            <Input
              id="workspace-name"
              value={workspaceName}
              onChange={(event) => setWorkspaceName(event.target.value)}
              required
              maxLength={120}
              autoFocus
            />
          </div>
          {createError && (
            <p role="alert" className="text-sm text-destructive">
              {createError}
            </p>
          )}
          <Button type="submit" disabled={creatingWorkspace}>
            {creatingWorkspace && <Loader2Icon className="animate-spin" />}
            Create workspace
          </Button>
        </form>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void signOutAndLeave(signOut, () => router.replace("/sign-in"))
          }
        >
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
