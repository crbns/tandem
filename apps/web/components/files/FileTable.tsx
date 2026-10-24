"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FolderIcon } from "lucide-react";
import type { FileSummary, FolderSummary } from "@/lib/api/types";
import { displayId } from "@/lib/files";
import { folderHref } from "@/lib/folders";
import { formatAbsolute, formatRelative } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { useArrivedFiles } from "@/lib/api/useWorkspace";
import { ActorBadge } from "@/components/common/ActorBadge";
import { FileActions } from "./FileActions";
import { FolderActions } from "./FolderActions";
import { CustodyStrip } from "@/components/files/CustodyStrip";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export const fileHref = (workspaceId: string, fileId: string) => `/w/${workspaceId}/files/${fileId}`;

function Header() {
  return (
    <TableHeader>
      <TableRow className="hover:bg-transparent">
        <TableHead className="hidden w-28 xl:table-cell">No.</TableHead>
        <TableHead>Name</TableHead>
        <TableHead className="hidden sm:table-cell">Custody</TableHead>
        <TableHead className="hidden md:table-cell">Last held by</TableHead>
        <TableHead className="text-right">Updated</TableHead>
        <TableHead>Actions</TableHead>
      </TableRow>
    </TableHeader>
  );
}

interface FileTableProps {
  workspaceId: string;
  /** Shown first; a click (or Enter) opens the folder. */
  folders?: FolderSummary[];
  files: FileSummary[];
  selectedId?: string;
  onSelect?: (fileId: string) => void;
  onChanged?: () => void;
}

/**
 * The file register. Folder rows come first and open on click. Selecting a file
 * row (click or focus) shows its custody record; the name link, a double click,
 * or Enter opens the file.
 */
export function FileTable({ workspaceId, folders = [], files, selectedId, onSelect, onChanged }: FileTableProps) {
  const router = useRouter();
  const now = useNow();
  const arrivedFiles = useArrivedFiles();

  return (
    <Table>
      <Header />
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
                  className="flex items-center gap-2 font-semibold hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  <FolderIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate">{folder.name}</span>
                </Link>
                <span className="mt-1 flex items-center gap-3 text-xs md:hidden">
                  <ActorBadge actor={folder.updatedBy} />
                </span>
              </TableCell>
              <TableCell className="hidden sm:table-cell" />
              <TableCell className="hidden md:table-cell">
                <ActorBadge actor={folder.updatedBy} />
              </TableCell>
              <TableCell className="text-right text-muted-foreground" title={formatAbsolute(folder.updatedAt)}>
                {formatRelative(folder.updatedAt, now)}
              </TableCell>
              <TableCell><FolderActions folder={folder} onChanged={onChanged} /></TableCell>
            </TableRow>
          );
        })}
        {files.map((file) => {
          const href = fileHref(workspaceId, file.id);
          const selected = file.id === selectedId;
          const arrived = arrivedFiles.has(file.id);
          return (
            <TableRow
              key={file.id}
              tabIndex={0}
              aria-selected={selected}
              data-arrived={arrived || undefined}
              className={cn(
                "cursor-pointer outline-none focus-visible:bg-accent",
                selected && "bg-accent",
                arrived && "animate-arrival",
              )}
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
              <TableCell><FileActions file={file} onChanged={onChanged} /></TableCell>
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
      <Header />
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
            <TableCell>
              <Skeleton className="h-8 w-32" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
