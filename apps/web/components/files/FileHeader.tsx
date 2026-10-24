import { displayId } from "@/lib/files";
import { crumbItems } from "@/lib/folders";
import { Breadcrumbs } from "@/components/files/Breadcrumbs";
import { FileIcon } from "@/components/files/FileIcon";

interface FileHeaderProps {
  workspaceId: string;
  fileId: string;
  name: string;
  mimeType: string;
  /** Extra breadcrumb after the file name, e.g. "History". */
  trail?: { label: string; fileHref: string };
  /** The folders holding the file, root first; empty at the workspace root. */
  folders?: { id: string; name: string }[];
}

const TYPE_LABEL: Record<string, string> = {
  "text/markdown": "Markdown",
  "text/plain": "Plain text",
};

export function FileHeader({ workspaceId, fileId, name, mimeType, trail, folders = [] }: FileHeaderProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <Breadcrumbs
        items={[
          ...crumbItems(workspaceId, folders),
          { label: name, href: `/w/${workspaceId}/files/${fileId}` },
          ...(trail ? [{ label: trail.label, href: trail.fileHref }] : []),
        ]}
      />
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
