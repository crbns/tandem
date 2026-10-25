"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { HomeIcon, RotateCwIcon, SearchIcon, XIcon } from "lucide-react";
import { useTandemApi, type FileSummary, type FolderSummary } from "@/lib/api";
import { useResource } from "@/lib/api/useResource";
import { useWorkspaceRefresh } from "@/lib/api/useWorkspace";
import { filterAndSortFiles } from "@/lib/files";
import { crumbItems, folderHref, folderTrail } from "@/lib/folders";
import { Breadcrumbs } from "@/components/files/Breadcrumbs";
import { FileTable, FileTableSkeleton } from "@/components/files/FileTable";
import { CustodyPanel } from "@/components/files/CustodyPanel";
import { UploadButton } from "@/components/files/UploadButton";
import { NewFileDialog } from "@/components/files/NewFileDialog";
import { NewFolderDialog } from "@/components/files/NewFolderDialog";
import { ErrorState } from "@/components/common/ErrorState";
import { TandemMark } from "@/components/common/TandemMark";
import { CustodyMark } from "@/components/common/CustodyMark";
import { ApprovedGoal } from "@/components/files/ApprovedGoal";
import { PendingApprovals } from "@/components/approvals/PendingApprovals";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export default function FilesPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const api = useTandemApi();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The current folder lives in the URL (?folder=<id>); no param is the root.
  const folderId = useSearchParams().get("folder") || null;

  const load = useCallback(() => api.listDirectory(workspaceId, folderId), [api, workspaceId, folderId]);
  const { resource: loaded, refreshing, reload } = useResource(load);
  // A listing for the folder we just left reads as loading, not as this folder.
  const resource = loaded.status === "ready" && (loaded.data.folder?.id ?? null) !== folderId ? { status: "loading" as const } : loaded;

  // A file an assistant creates or saves through MCP records a workspace
  // event; refetch on it (and on focus) so it shows up without a reload.
  useWorkspaceRefresh(workspaceId, reload);

  const listing = resource.status === "ready" ? resource.data : null;
  const empty = listing !== null && listing.folders.length === 0 && listing.files.length === 0;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <Breadcrumbs items={crumbItems(workspaceId, listing ? folderTrail(listing) : [])} />
          <h1 className="truncate text-2xl font-bold leading-8 tracking-[-0.01em]">{listing?.folder?.name ?? "Files"}</h1>
        </div>
        {listing && (
          <span className="pb-1 text-sm text-muted-foreground">
            {countLabel(listing.folders.length, listing.files.length)} · every version kept
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={reload} disabled={refreshing} aria-label="Refresh file list">
            <RotateCwIcon className={cn(refreshing && "animate-spin")} />
            Refresh
          </Button>
          <NewFolderDialog workspaceId={workspaceId} parentId={folderId} onCreated={reload} />
          <UploadButton workspaceId={workspaceId} parentId={folderId} />
          <NewFileDialog workspaceId={workspaceId} parentId={folderId} />
        </div>
      </div>

      <ApprovedGoal workspaceId={workspaceId} />
      <PendingApprovals workspaceId={workspaceId} />

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
          placeholder="Filter this folder by name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="bg-card pl-8 pr-8"
          aria-label="Filter files and folders by name"
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

      {resource.status === "error" && (
        <div className="flex flex-col items-start gap-3">
          <ErrorState error={resource.error} onRetry={reload} retrying={refreshing} />
          {resource.error.code === "FOLDER_NOT_FOUND" && (
            <Button variant="outline" size="sm" asChild>
              <Link href={folderHref(workspaceId, null)}>
                <HomeIcon />
                Back to workspace root
              </Link>
            </Button>
          )}
        </div>
      )}

      {listing && empty && !folderId && (
        <div className="flex flex-col items-center gap-3 rounded-md border bg-card px-6 py-16 text-center">
          <TandemMark className="size-9" />
          <p className="text-base font-semibold">No files yet</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Create one, or ask your assistant to create one through Tandem. Files an assistant saves appear here
            marked Agent, usually within a moment.
          </p>
        </div>
      )}

      {listing && empty && folderId && (
        <div className="flex flex-col items-center gap-3 rounded-md border bg-card px-6 py-16 text-center">
          <TandemMark className="size-9" />
          <p className="text-base font-semibold">This folder is empty</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Create a file or folder here, upload one, or move files in with Move….
          </p>
        </div>
      )}

      {listing && !empty && (
        <Register
          workspaceId={workspaceId}
          folders={listing.folders}
          files={listing.files}
          query={query}
          onChanged={reload}
          onClear={() => setQuery("")}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      )}
    </div>
  );
}

/** "2 folders, 3 files"; folders are left out when there are none. */
function countLabel(folders: number, files: number) {
  const fileLabel = files === 1 ? "1 file" : `${files} files`;
  if (folders === 0) return fileLabel;
  return `${folders === 1 ? "1 folder" : `${folders} folders`}, ${fileLabel}`;
}

interface RegisterProps {
  workspaceId: string;
  folders: FolderSummary[];
  files: FileSummary[];
  query: string;
  onClear: () => void;
  onChanged: () => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function Register({ workspaceId, folders, files, query, onClear, selectedId, onSelect, onChanged }: RegisterProps) {
  const visible = filterAndSortFiles(files, query);
  const q = query.trim().toLowerCase();
  const visibleFolders = folders.filter((f) => !q || f.name.toLowerCase().includes(q));
  // Default to the most recently changed file so the record panel is never empty.
  const selected = visible.find((f) => f.id === selectedId) ?? visible[0];

  if (!selected && visibleFolders.length === 0) {
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
        <FileTable
          onChanged={onChanged}
          workspaceId={workspaceId}
          folders={visibleFolders}
          files={visible}
          selectedId={selected?.id}
          onSelect={onSelect}
        />
      </div>
      {/* The record panel needs room beside a readable register: wide screens only. */}
      {selected && (
        <div className="hidden xl:block">
          <CustodyPanel key={selected.id} workspaceId={workspaceId} file={selected} />
        </div>
      )}
    </div>
  );
}
