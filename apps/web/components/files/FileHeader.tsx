import Link from "next/link";
import { ChevronRightIcon } from "lucide-react";
import { FileIcon } from "@/components/files/FileIcon";

interface FileHeaderProps {
  workspaceId: string;
  name: string;
  mimeType: string;
  /** Extra breadcrumb after the file name, e.g. "History". */
  trail?: { label: string; fileHref: string };
}

export function FileHeader({ workspaceId, name, mimeType, trail }: FileHeaderProps) {
  return (
    <div className="flex flex-col gap-1">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm text-muted-foreground">
        <Link href={`/w/${workspaceId}`} className="hover:text-foreground">
          Files
        </Link>
        <ChevronRightIcon className="size-3.5" />
        {trail ? (
          <>
            <Link href={trail.fileHref} className="hover:text-foreground">
              {name}
            </Link>
            <ChevronRightIcon className="size-3.5" />
            <span>{trail.label}</span>
          </>
        ) : (
          <span>{name}</span>
        )}
      </nav>
      <h1 className="flex items-center gap-2 text-xl font-semibold">
        <FileIcon mimeType={mimeType} className="size-5" />
        {trail ? `${trail.label}: ${name}` : name}
      </h1>
    </div>
  );
}
