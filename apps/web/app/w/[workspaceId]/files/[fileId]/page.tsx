"use client";

import { useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { FileQuestionIcon, HistoryIcon } from "lucide-react";
import { TandemApiError, useTandemApi } from "@/lib/api";
import { useResource } from "@/lib/api/useResource";
import { belongsToWorkspace, isTextMimeType } from "@/lib/files";
import { formatAbsolute } from "@/lib/time";
import { FileEditor } from "@/components/editor/FileEditor";
import { FileActions } from "@/components/files/FileActions";
import { FileHeader } from "@/components/files/FileHeader";
import { ActorBadge } from "@/components/common/ActorBadge";
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
  const fileHref = `/w/${workspaceId}/files/${fileId}`;

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
      <FileHeader workspaceId={workspaceId} fileId={file.id} name={file.name} mimeType={file.mimeType} />
      <FileActions file={file} onChanged={reload} redirectAfterDelete />
      {isTextMimeType(file.mimeType) && file.content !== null ? (
        // Keyed by id so a different file always starts a fresh save machine.
        <FileEditor key={file.id} file={file} historyHref={`${fileHref}/history`} />
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-lg border px-6 py-16 text-center">
          <FileQuestionIcon className="size-8 text-muted-foreground" />
          <p className="font-medium">Preview not supported yet</p>
          <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-left text-sm">
            <dt className="text-muted-foreground">Type</dt>
            <dd>{file.mimeType}</dd>
            <dt className="text-muted-foreground">Version</dt>
            <dd>v{file.version}</dd>
            <dt className="text-muted-foreground">Last edited</dt>
            <dd className="flex items-center gap-2">
              <ActorBadge actor={file.updatedBy} /> {formatAbsolute(file.updatedAt)}
            </dd>
          </dl>
          <Button variant="outline" size="sm" asChild>
            <Link href={`${fileHref}/history`}>
              <HistoryIcon />
              History
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}
