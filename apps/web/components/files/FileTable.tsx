"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { FileSummary } from "@/lib/api/types";
import { formatAbsolute, formatRelative } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { ActorBadge } from "@/components/common/ActorBadge";
import { FileIcon } from "@/components/files/FileIcon";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const fileHref = (workspaceId: string, fileId: string) => `/w/${workspaceId}/files/${fileId}`;

function Header() {
  return (
    <TableHeader>
      <TableRow className="hover:bg-transparent">
        <TableHead className="w-full">Name</TableHead>
        <TableHead>Version</TableHead>
        <TableHead>Last edited by</TableHead>
        <TableHead className="text-right">Updated</TableHead>
      </TableRow>
    </TableHeader>
  );
}

export function FileTable({ workspaceId, files }: { workspaceId: string; files: FileSummary[] }) {
  const router = useRouter();
  const now = useNow();

  return (
    <Table>
      <Header />
      <TableBody>
        {files.map((file) => (
          <TableRow
            key={file.id}
            className="cursor-pointer"
            onClick={() => router.push(fileHref(workspaceId, file.id))}
          >
            <TableCell>
              <Link
                href={fileHref(workspaceId, file.id)}
                className="flex items-center gap-2 font-medium hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                <FileIcon mimeType={file.mimeType} />
                {file.name}
              </Link>
            </TableCell>
            <TableCell className="tabular-nums text-muted-foreground">v{file.version}</TableCell>
            <TableCell>
              <ActorBadge actor={file.updatedBy} />
            </TableCell>
            <TableCell
              className="text-right text-muted-foreground"
              title={formatAbsolute(file.updatedAt)}
            >
              {formatRelative(file.updatedAt, now)}
            </TableCell>
          </TableRow>
        ))}
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
            <TableCell>
              <Skeleton className="h-4 w-48" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-8" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-5 w-32" />
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
