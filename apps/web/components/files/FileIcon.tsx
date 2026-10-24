import { FileIcon as GenericFileIcon, FileTextIcon, FileTypeIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function FileIcon({ mimeType, className }: { mimeType: string; className?: string }) {
  const Icon =
    mimeType === "text/markdown" ? FileTypeIcon : mimeType.startsWith("text/") ? FileTextIcon : GenericFileIcon;
  return <Icon className={cn("size-4 shrink-0 text-muted-foreground", className)} />;
}
