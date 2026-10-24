"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { FileSummary } from "@/lib/api/types";
import { displayId } from "@/lib/files";
import { formatAbsolute, formatRelative } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { ActorBadge } from "@/components/common/ActorBadge";
import { FileActions } from "./FileActions";
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
  files: FileSummary[];
  selectedId?: string;
  onSelect?: (fileId: string) => void;
  onChanged?: () => void;
}

/**
 * The file register. Selecting a row (click or focus) shows its custody record;
 * the name link, a double click, or Enter opens the file.
 */
export function FileTable({ workspaceId, files, selectedId, onSelect, onChanged }: FileTableProps) {
  const router = useRouter();
  const now = useNow();

  return (
    <Table>
      <Header />
      <TableBody>
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
