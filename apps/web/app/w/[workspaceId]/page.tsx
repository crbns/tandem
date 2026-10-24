"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { RotateCwIcon, SearchIcon, XIcon } from "lucide-react";
import { useTandemApi, type FileSummary } from "@/lib/api";
import { useResource } from "@/lib/api/useResource";
import { filterAndSortFiles } from "@/lib/files";
import { FileTable, FileTableSkeleton } from "@/components/files/FileTable";
import { CustodyPanel } from "@/components/files/CustodyPanel";
import { NewFileDialog } from "@/components/files/NewFileDialog";
import { ErrorState } from "@/components/common/ErrorState";
import { TandemMark } from "@/components/common/TandemMark";
import { CustodyMark } from "@/components/common/CustodyMark";
import { ApprovedGoal } from "@/components/files/ApprovedGoal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export default function FilesPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const api = useTandemApi();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(() => api.listFiles(workspaceId), [api, workspaceId]);
  const { resource, refreshing, reload } = useResource(load);

  // No realtime in P0: refetching on focus is how an MCP-created file shows up.
  useEffect(() => {
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);

  const count = resource.status === "ready" ? resource.data.length : null;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <h1 className="text-2xl font-bold leading-8 tracking-[-0.01em]">Files</h1>
        {count !== null && (
          <span className="pb-1 text-sm text-muted-foreground">
            {count === 1 ? "1 record" : `${count} records`} · every version kept
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={reload} disabled={refreshing} aria-label="Refresh file list">
            <RotateCwIcon className={cn(refreshing && "animate-spin")} />
            Refresh
          </Button>
          <NewFileDialog workspaceId={workspaceId} />
        </div>
      </div>

      <ApprovedGoal workspaceId={workspaceId} />

      {/* The rail carries the mark legend on wide screens; small screens get it here. */}
      <p className="flex items-center gap-3 text-xs text-muted-foreground md:hidden">
        <span className="inline-flex items-center gap-1.5">
          <CustodyMark kind="agent" /> Agent (assistant via MCP)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <CustodyMark kind="human" /> Human
        </span>
      </p>

      <div className="relative w-full sm:max-w-xs">
        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Filter by name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="bg-card pl-8 pr-8"
          aria-label="Filter files by name"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear filter"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        )}
      </div>

      {resource.status === "loading" && (
        <div className="rounded-md border bg-card">
          <FileTableSkeleton />
        </div>
      )}

      {resource.status === "error" && <ErrorState error={resource.error} onRetry={reload} retrying={refreshing} />}

      {resource.status === "ready" && resource.data.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-md border bg-card px-6 py-16 text-center">
          <TandemMark className="size-9" />
          <p className="text-base font-semibold">No files yet</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Create one, or ask your assistant to create one through Tandem. Files an assistant saves appear here
            marked Agent; press Refresh if one doesn&apos;t show up yet.
          </p>
        </div>
      )}

      {resource.status === "ready" && resource.data.length > 0 && (
        <Register
          workspaceId={workspaceId}
          files={resource.data}
          query={query}
          onClear={() => setQuery("")}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      )}
    </div>
  );
}

interface RegisterProps {
  workspaceId: string;
  files: FileSummary[];
  query: string;
  onClear: () => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function Register({ workspaceId, files, query, onClear, selectedId, onSelect }: RegisterProps) {
  const visible = filterAndSortFiles(files, query);
  // Default to the most recently changed file so the record panel is never empty.
  const selected = visible.find((f) => f.id === selectedId) ?? visible[0];

  if (!selected) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-md border bg-card px-6 py-10 text-center text-sm text-muted-foreground">
        No files match &ldquo;{query.trim()}&rdquo;.
        <Button variant="outline" size="sm" onClick={onClear}>
          Clear filter
        </Button>
      </div>
    );
  }

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="overflow-hidden rounded-md border bg-card">
        <FileTable workspaceId={workspaceId} files={visible} selectedId={selected.id} onSelect={onSelect} />
      </div>
      {/* The record panel needs room beside a readable register: wide screens only. */}
      <div className="hidden xl:block">
        <CustodyPanel key={selected.id} workspaceId={workspaceId} file={selected} />
      </div>
    </div>
  );
}
