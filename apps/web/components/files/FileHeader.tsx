import Link from "next/link";
import { ChevronRightIcon } from "lucide-react";
import type { Folder } from "@/lib/api/types";
import { displayId, folderHref } from "@/lib/files";
import { FileIcon } from "@/components/files/FileIcon";

interface FileHeaderProps {
  workspaceId: string;
  fileId: string;
  name: string;
  mimeType: string;
  /** Extra breadcrumb after the file name, e.g. "History". */
  trail?: { label: string; fileHref: string };
  /** The file's folders, top level first, shown between Files and the name. */
  folderPath?: Pick<Folder, "id" | "name">[];
}

const TYPE_LABEL: Record<string, string> = {
  "text/markdown": "Markdown",
  "text/plain": "Plain text",
};

export function FileHeader({ workspaceId, fileId, name, mimeType, trail, folderPath = [] }: FileHeaderProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
        <Link href={`/w/${workspaceId}`} className="hover:text-foreground">
          Files
        </Link>
        <ChevronRightIcon className="size-3.5" aria-hidden />
        {folderPath.map((folder) => (
          <span key={folder.id} className="contents">
            <Link href={folderHref(workspaceId, folder.id)} className="hover:text-foreground">
              {folder.name}
            </Link>
            <ChevronRightIcon className="size-3.5" aria-hidden />
          </span>
        ))}
        {trail ? (
          <>
            <Link href={trail.fileHref} className="hover:text-foreground">
              {name}
            </Link>
            <ChevronRightIcon className="size-3.5" aria-hidden />
            <span className="text-foreground">{trail.label}</span>
          </>
        ) : (
          <span className="text-foreground">{name}</span>
        )}
      </nav>
      <h1 className="flex items-center gap-2 text-2xl font-bold leading-8 tracking-[-0.01em]">
        <FileIcon mimeType={mimeType} className="size-5" />
        {trail ? `${trail.label}: ${name}` : name}
      </h1>
      <p className="label-caps text-muted-foreground">
        {displayId(fileId)} · {TYPE_LABEL[mimeType] ?? mimeType}
      </p>
    </div>
  );
}
