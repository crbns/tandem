"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { FileTextIcon, RotateCwIcon, SearchIcon } from "lucide-react";
import { useTandemApi } from "@/lib/api";
import { useResource } from "@/lib/api/useResource";
import { filterAndSortFiles } from "@/lib/files";
import { FileTable, FileTableSkeleton } from "@/components/files/FileTable";
import { NewFileDialog } from "@/components/files/NewFileDialog";
import { ErrorState } from "@/components/common/ErrorState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export default function FilesPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const api = useTandemApi();
  const [query, setQuery] = useState("");

  const load = useCallback(() => api.listFiles(workspaceId), [api, workspaceId]);
  const { resource, refreshing, reload } = useResource(load);

  // No realtime in P0: refetching on focus is how an MCP-created file shows up.
  useEffect(() => {
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Files</h1>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={reload}
            disabled={refreshing}
            aria-label="Refresh file list"
          >
            <RotateCwIcon className={cn(refreshing && "animate-spin")} />
            Refresh
          </Button>
          <NewFileDialog workspaceId={workspaceId} />
        </div>
      </div>

      <div className="relative max-w-xs">
        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Filter by name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-8"
          aria-label="Filter files by name"
        />
      </div>

      <div className="rounded-lg border">
        {resource.status === "loading" && <FileTableSkeleton />}

        {resource.status === "error" && (
          <div className="p-4">
            <ErrorState error={resource.error} onRetry={reload} />
          </div>
        )}

        {resource.status === "ready" && resource.data.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
            <FileTextIcon className="size-8 text-muted-foreground" />
            <p className="font-medium">No files yet</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Create one, or ask your assistant to create one through Tandem.
            </p>
          </div>
        )}

        {resource.status === "ready" && resource.data.length > 0 && (
          <FilteredFiles workspaceId={workspaceId} files={resource.data} query={query} />
        )}
      </div>
    </div>
  );
}

function FilteredFiles({
  workspaceId,
  files,
  query,
}: {
  workspaceId: string;
  files: Parameters<typeof filterAndSortFiles>[0];
  query: string;
}) {
  const visible = filterAndSortFiles(files, query);
  if (visible.length === 0) {
    return (
      <p className="px-6 py-10 text-center text-sm text-muted-foreground">
        No files match &ldquo;{query.trim()}&rdquo;.
      </p>
    );
  }
  return <FileTable workspaceId={workspaceId} files={visible} />;
}
