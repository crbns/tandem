"use client";

import type { MouseEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FolderIcon, FolderInputIcon, MoreHorizontalIcon, PencilIcon } from "lucide-react";
import type { FileSummary, Folder } from "@/lib/api/types";
import { displayId, folderHref } from "@/lib/files";
import { formatAbsolute, formatRelative } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { ActorBadge } from "@/components/common/ActorBadge";
import { CustodyStrip } from "@/components/files/CustodyStrip";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export const fileHref = (workspaceId: string, fileId: string) => `/w/${workspaceId}/files/${fileId}`;

function Header({ actions }: { actions: boolean }) {
  return (
    <TableHeader>
      <TableRow className="hover:bg-transparent">
        <TableHead className="hidden w-28 xl:table-cell">No.</TableHead>
        <TableHead>Name</TableHead>
        <TableHead className="hidden sm:table-cell">Custody</TableHead>
        <TableHead className="hidden md:table-cell">Last held by</TableHead>
        <TableHead className="text-right">Updated</TableHead>
        {actions && (
          <TableHead className="w-12 pl-0">
            <span className="sr-only">Actions</span>
          </TableHead>
        )}
      </TableRow>
    </TableHeader>
  );
}

interface FileTableProps {
  workspaceId: string;
  files: FileSummary[];
  /** Listed before the files; opening one navigates into it. */
  folders?: Folder[];
  selectedId?: string;
  onSelect?: (fileId: string) => void;
  /** Adds a per-row actions menu with Move. */
  onMove?: (file: FileSummary) => void;
  /** Adds Rename to each folder row's actions menu. */
  onRenameFolder?: (folder: Folder) => void;
  /** Adds Move to each folder row's actions menu. */
  onMoveFolder?: (folder: Folder) => void;
}

/** Keeps clicks in the actions cell from selecting or opening the row. */
const stopRow = {
  onClick: (e: MouseEvent) => e.stopPropagation(),
  onDoubleClick: (e: MouseEvent) => e.stopPropagation(),
};

/**
 * The file register. Selecting a row (click or focus) shows its custody record;
 * the name link, a double click, or Enter opens the file. Folder rows come
 * first, and a click or Enter on one opens it.
 */
export function FileTable({
  workspaceId,
  files,
  folders = [],
  selectedId,
  onSelect,
  onMove,
  onRenameFolder,
  onMoveFolder,
}: FileTableProps) {
  const router = useRouter();
  const now = useNow();
  const folderActions = !!(onRenameFolder || onMoveFolder);
  const actions = !!onMove || folderActions;

  return (
    <Table>
      <Header actions={actions} />
      <TableBody>
        {folders.map((folder) => {
          const href = folderHref(workspaceId, folder.id);
          return (
            <TableRow
              key={folder.id}
              tabIndex={0}
              className="cursor-pointer outline-none focus-visible:bg-accent"
              onClick={() => router.push(href)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.target === e.currentTarget) router.push(href);
              }}
            >
              <TableCell className="label-caps hidden text-muted-foreground xl:table-cell">Folder</TableCell>
              <TableCell className="w-full min-w-40 max-w-0">
                <Link
                  href={href}
                  className="flex items-center gap-1.5 font-semibold hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  <FolderIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate">{folder.name}</span>
                  <span className="sr-only">(folder)</span>
                </Link>
              </TableCell>
              <TableCell className="hidden sm:table-cell" />
              <TableCell className="hidden md:table-cell">
                <ActorBadge actor={folder.updatedBy} />
              </TableCell>
              <TableCell className="text-right text-muted-foreground" title={formatAbsolute(folder.updatedAt)}>
                {formatRelative(folder.updatedAt, now)}
              </TableCell>
              {folderActions ? (
                <TableCell className="py-0 pl-0 pr-2" {...stopRow}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for folder ${folder.name}`}>
                        <MoreHorizontalIcon />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {onRenameFolder && (
                        <DropdownMenuItem onSelect={() => onRenameFolder(folder)}>
                          <PencilIcon />
                          Rename…
                        </DropdownMenuItem>
                      )}
                      {onMoveFolder && (
                        <DropdownMenuItem onSelect={() => onMoveFolder(folder)}>
                          <FolderInputIcon />
                          Move…
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              ) : (
                actions && <TableCell className="pl-0" />
              )}
            </TableRow>
          );
        })}
        {files.map((file) => {
          const href = fileHref(workspaceId, file.id);
          const selected = file.id === selectedId;
          return (
            <TableRow
              key={file.id}
              tabIndex={0}
              aria-selected={selected}
              className={cn("cursor-pointer outline-none focus-visible:bg-accent", selected && "bg-accent")}
              onClick={() => onSelect?.(file.id)}
              onFocus={() => onSelect?.(file.id)}
              onDoubleClick={() => router.push(href)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.target === e.currentTarget) router.push(href);
              }}
            >
              <TableCell className="label-caps hidden text-muted-foreground xl:table-cell">
                {displayId(file.id)}
              </TableCell>
              <TableCell className="w-full min-w-40 max-w-0">
                <Link
                  href={href}
                  className="block truncate font-semibold hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  {file.name}
                </Link>
                {/* On narrow screens the hidden columns collapse into this line. */}
                <span className="mt-1 flex items-center gap-3 text-xs md:hidden">
                  <span className="sm:hidden"><CustodyStrip file={file} /></span>
                  <ActorBadge actor={file.updatedBy} />
                </span>
              </TableCell>
              <TableCell className="hidden sm:table-cell">
                <CustodyStrip file={file} />
              </TableCell>
              <TableCell className="hidden md:table-cell">
                <ActorBadge actor={file.updatedBy} />
              </TableCell>
              <TableCell className="text-right text-muted-foreground" title={formatAbsolute(file.updatedAt)}>
                {formatRelative(file.updatedAt, now)}
              </TableCell>
              {onMove ? (
                <TableCell className="py-0 pl-0 pr-2" {...stopRow}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${file.name}`}>
                        <MoreHorizontalIcon />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => onMove(file)}>
                        <FolderInputIcon />
                        Move…
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              ) : (
                actions && <TableCell className="pl-0" />
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function FileTableSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <Table aria-busy="true">
      <Header actions={false} />
      <TableBody>
        {Array.from({ length: rows }, (_, i) => (
          <TableRow key={i} className="hover:bg-transparent">
            <TableCell className="hidden xl:table-cell">
              <Skeleton className="h-4 w-16" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-40" />
            </TableCell>
            <TableCell className="hidden sm:table-cell">
              <Skeleton className="h-3 w-20" />
            </TableCell>
            <TableCell className="hidden md:table-cell">
              <Skeleton className="h-4 w-32" />
            </TableCell>
            <TableCell>
              <Skeleton className="ml-auto h-4 w-16" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
