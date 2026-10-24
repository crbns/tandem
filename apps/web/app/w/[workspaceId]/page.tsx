"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  ChevronRightIcon,
  FolderIcon,
  FolderInputIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RotateCwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { useTandemApi, type FileSummary, type Folder } from "@/lib/api";
import { useResource } from "@/lib/api/useResource";
import { useWorkspaceRefresh } from "@/lib/api/useWorkspace";
import { childFolders, filterAndSortFiles, findFolder, folderHref, folderPath } from "@/lib/files";
import { FileTable, FileTableSkeleton } from "@/components/files/FileTable";
import { CustodyPanel } from "@/components/files/CustodyPanel";
import { InviteDialog } from "@/components/files/InviteDialog";
import { MoveFileDialog } from "@/components/files/MoveFileDialog";
import { MoveFolderDialog } from "@/components/files/MoveFolderDialog";
import { RenameFolderDialog } from "@/components/files/RenameFolderDialog";
import { NewFileDialog } from "@/components/files/NewFileDialog";
import { NewFolderDialog } from "@/components/files/NewFolderDialog";
import { ErrorState } from "@/components/common/ErrorState";
import { TandemMark } from "@/components/common/TandemMark";
import { CustodyMark } from "@/components/common/CustodyMark";
import { ApprovedGoal } from "@/components/files/ApprovedGoal";
import { PendingApprovals } from "@/components/approvals/PendingApprovals";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// useSearchParams needs a Suspense boundary above it.
export default function FilesPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-6xl rounded-md border bg-card">
          <FileTableSkeleton />
        </div>
      }
    >
      <FilesView />
    </Suspense>
  );
}

function FilesView() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const api = useTandemApi();
  const router = useRouter();
  // The folder being viewed lives in the URL so reload and back/forward keep it.
  const folderParam = useSearchParams().get("folder");
  // The filter belongs to the folder it was typed in.
  const [filter, setFilter] = useState({ folder: folderParam, query: "" });
  const query = filter.folder === folderParam ? filter.query : "";
  const setQuery = (next: string) => setFilter({ folder: folderParam, query: next });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  // Which folder dialog is open, by id, so a refetch hands it the latest revision.
  const [folderAction, setFolderAction] = useState<{ kind: "rename" | "move"; id: string } | null>(null);

  // listFiles returns every file with its parentId, so one load covers every
  // folder; the register filters to the current one client-side.
  const load = useCallback(async () => {
    const [files, folders] = await Promise.all([api.listFiles(workspaceId), api.listFolders(workspaceId)]);
    return { files, folders };
  }, [api, workspaceId]);
  const { resource, refreshing, reload } = useResource(load);

  // A file or folder an assistant creates, saves or moves through MCP records a
  // workspace event; refetch both lists on it (and on focus) without a reload.
  useWorkspaceRefresh(workspaceId, reload);

  const data = resource.status === "ready" ? resource.data : null;
  const folder = data ? findFolder(data.folders, folderParam) : null;
  // An unknown or other-workspace ?folder falls back to the top level.
  const missingFolder = !!data && !!folderParam && !folder;
  const warned = useRef<string | null>(null);
  useEffect(() => {
    if (!missingFolder || warned.current === folderParam) return;
    warned.current = folderParam;
    toast.error("That folder isn't in this workspace. Showing the top level.");
    router.replace(folderHref(workspaceId, null));
  }, [missingFolder, folderParam, router, workspaceId]);

  const folderId = folder?.id ?? null;
  const path = data ? folderPath(data.folders, folder) : [];
  const filesHere = data ? data.files.filter((f) => f.parentId === folderId) : [];
  const foldersHere = data ? childFolders(data.folders, folderId) : [];
  const movingFile = (movingId && data?.files.find((f) => f.id === movingId)) || null;
  const actionFolder = data ? findFolder(data.folders, folderAction?.id) : null;
  const renamingFolder = folderAction?.kind === "rename" ? actionFolder : null;
  const movingFolder = folderAction?.kind === "move" ? actionFolder : null;
  const renameFolder = (f: Folder) => setFolderAction({ kind: "rename", id: f.id });
  const moveFolder = (f: Folder) => setFolderAction({ kind: "move", id: f.id });
  const closeFolderAction = (open: boolean) => !open && setFolderAction(null);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <div className="flex flex-col gap-1.5">
          {folder && <FolderBreadcrumb workspaceId={workspaceId} path={path} />}
          <div className="flex items-center gap-1">
            <h1 className="flex items-center gap-2 text-2xl font-bold leading-8 tracking-[-0.01em]">
              {folder && <FolderIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden />}
              {folder ? folder.name : "Files"}
            </h1>
            {folder && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for folder ${folder.name}`}>
                    <MoreHorizontalIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onSelect={() => renameFolder(folder)}>
                    <PencilIcon />
                    Rename folder…
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => moveFolder(folder)}>
                    <FolderInputIcon />
                    Move folder…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
        {data && (
          <span className="pb-1 text-sm text-muted-foreground">
            {foldersHere.length > 0 && `${foldersHere.length === 1 ? "1 folder" : `${foldersHere.length} folders`} · `}
            {filesHere.length === 1 ? "1 record" : `${filesHere.length} records`} · every version kept
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={reload} disabled={refreshing} aria-label="Refresh file list">
            <RotateCwIcon className={cn(refreshing && "animate-spin")} />
            Refresh
          </Button>
          <InviteDialog workspaceId={workspaceId} />
          <NewFolderDialog workspaceId={workspaceId} parentId={folderId} parentName={folder?.name} onCreated={reload} />
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
          placeholder="Filter by name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="bg-card pl-8 pr-8"
          aria-label={folder ? `Filter ${folder.name} by name` : "Filter files by name"}
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

      {data && filesHere.length === 0 && foldersHere.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-md border bg-card px-6 py-16 text-center">
          <TandemMark className="size-9" />
          {folder ? (
            <>
              <p className="text-base font-semibold">This folder is empty</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                New files and folders you create here land in {folder.name}. You can also move a file in from its
                current folder, or ask your assistant to save into it.
              </p>
            </>
          ) : (
            <>
              <p className="text-base font-semibold">No files yet</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                Create one, or ask your assistant to create one through Tandem. Files an assistant saves appear here
                marked Agent, usually within a moment.
              </p>
            </>
          )}
        </div>
      )}

      {data && (filesHere.length > 0 || foldersHere.length > 0) && (
        <Register
          workspaceId={workspaceId}
          files={filesHere}
          folders={data.folders}
          folderId={folderId}
          query={query}
          onClear={() => setQuery("")}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onMove={(file) => setMovingId(file.id)}
          onRenameFolder={renameFolder}
          onMoveFolder={moveFolder}
        />
      )}

      <MoveFileDialog
        file={movingFile}
        folders={data?.folders ?? []}
        onOpenChange={(open) => !open && setMovingId(null)}
        onRefresh={reload}
      />
      <RenameFolderDialog folder={renamingFolder} onOpenChange={closeFolderAction} onRefresh={reload} />
      <MoveFolderDialog
        folder={movingFolder}
        folders={data?.folders ?? []}
        onOpenChange={closeFolderAction}
        onRefresh={reload}
      />
    </div>
  );
}

function FolderBreadcrumb({ workspaceId, path }: { workspaceId: string; path: Folder[] }) {
  const ancestors = path.slice(0, -1);
  const current = path[path.length - 1];
  return (
    <nav aria-label="Folder" className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
      <Link href={folderHref(workspaceId, null)} className="hover:text-foreground">
        Files
      </Link>
      {ancestors.map((f) => (
        <span key={f.id} className="contents">
          <ChevronRightIcon className="size-3.5" aria-hidden />
          <Link href={folderHref(workspaceId, f.id)} className="hover:text-foreground">
            {f.name}
          </Link>
        </span>
      ))}
      {current && (
        <>
          <ChevronRightIcon className="size-3.5" aria-hidden />
          <span className="text-foreground" aria-current="page">
            {current.name}
          </span>
        </>
      )}
    </nav>
  );
}

interface RegisterProps {
  workspaceId: string;
  /** Files in the current folder. */
  files: FileSummary[];
  /** Every folder in the workspace. */
  folders: Folder[];
  folderId: string | null;
  query: string;
  onClear: () => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onMove: (file: FileSummary) => void;
  onRenameFolder: (folder: Folder) => void;
  onMoveFolder: (folder: Folder) => void;
}

function Register({
  workspaceId,
  files,
  folders,
  folderId,
  query,
  onClear,
  selectedId,
  onSelect,
  onMove,
  onRenameFolder,
  onMoveFolder,
}: RegisterProps) {
  const visible = filterAndSortFiles(files, query);
  const visibleFolders = childFolders(folders, folderId, query);
  // Default to the most recently changed file so the record panel is never empty.
  const selected = visible.find((f) => f.id === selectedId) ?? visible[0];

  if (!selected && visibleFolders.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-md border bg-card px-6 py-10 text-center text-sm text-muted-foreground">
        No files or folders match &ldquo;{query.trim()}&rdquo;.
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
          workspaceId={workspaceId}
          files={visible}
          folders={visibleFolders}
          selectedId={selected?.id}
          onSelect={onSelect}
          onMove={onMove}
          onRenameFolder={onRenameFolder}
          onMoveFolder={onMoveFolder}
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
