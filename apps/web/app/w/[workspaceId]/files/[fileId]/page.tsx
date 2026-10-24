"use client";

import { useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { HistoryIcon } from "lucide-react";
import { TandemApiError, useTandemApi } from "@/lib/api";
import { useResource } from "@/lib/api/useResource";
import { belongsToWorkspace, isTextMimeType } from "@/lib/files";
import { folderTrail } from "@/lib/folders";
import { BinaryPreview } from "@/components/files/BinaryPreview";
import { useWorkspaceRefresh } from "@/lib/api/useWorkspace";
import { FileEditor } from "@/components/editor/FileEditor";
import { FileActions } from "@/components/files/FileActions";
import { FileHeader } from "@/components/files/FileHeader";
import { ErrorState } from "@/components/common/ErrorState";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export default function FilePage() {
  const { workspaceId, fileId } = useParams<{ workspaceId: string; fileId: string }>();
  const api = useTandemApi();
  const load = useCallback(async () => {
    const file = await api.readFile(fileId);
    if (!belongsToWorkspace(file, workspaceId)) throw new TandemApiError("FILE_NOT_FOUND");
    return file;
  }, [api, fileId, workspaceId]);
  const { resource, refreshing, reload } = useResource(load);
  useWorkspaceRefresh(workspaceId, reload);
  const fileHref = `/w/${workspaceId}/files/${fileId}`;
  // The folder trail for the breadcrumbs; refetched when the file moves.
  const parentId = resource.status === "ready" ? resource.data.parentId : null;
  const loadTrail = useCallback(
    async () => (parentId ? folderTrail(await api.listDirectory(workspaceId, parentId)) : []),
    [api, workspaceId, parentId],
  );
  const { resource: trail, reload: reloadTrail } = useResource(loadTrail);
  useWorkspaceRefresh(workspaceId, reloadTrail);

  if (resource.status === "loading") {
    return (
      <div className="mx-auto flex max-w-6xl flex-col gap-4" aria-busy="true">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-[60vh] w-full" />
      </div>
    );
  }

  if (resource.status === "error") {
    return (
      <div className="mx-auto max-w-2xl">
        <ErrorState error={resource.error} onRetry={reload} retrying={refreshing} />
      </div>
    );
  }

  const file = resource.data;
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <FileHeader
        workspaceId={workspaceId}
        fileId={file.id}
        name={file.name}
        mimeType={file.mimeType}
        folders={trail.status === "ready" ? trail.data : []}
      />
      <FileActions file={file} onChanged={reload} redirectAfterDelete />
      {isTextMimeType(file.mimeType) && file.content !== null ? (
        // Keyed by id so a different file always starts a fresh save machine.
        <FileEditor key={file.id} file={file} historyHref={`${fileHref}/history`} />
      ) : (
        <div className="flex flex-col gap-3">
          <BinaryPreview file={file} onUploaded={reload} />
          <Button variant="outline" size="sm" asChild>
            <Link href={`${fileHref}/history`}><HistoryIcon />History</Link>
          </Button>
        </div>
      )}
    </div>
  );
}
