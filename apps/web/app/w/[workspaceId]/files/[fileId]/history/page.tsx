"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeftIcon, InfoIcon } from "lucide-react";
import { useTandemApi, type FileDetail, type Revision } from "@/lib/api";
import { useResource } from "@/lib/api/useResource";
import { isMarkdown } from "@/lib/files";
import { formatAbsolute } from "@/lib/time";
import { FileHeader } from "@/components/files/FileHeader";
import { RevisionList } from "@/components/history/RevisionList";
import { MarkdownPreview } from "@/components/editor/MarkdownPreview";
import { ActorBadge } from "@/components/common/ActorBadge";
import { DiffView } from "@/components/common/DiffView";
import { ErrorState } from "@/components/common/ErrorState";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type View = "rendered" | "raw" | "compare";
const isView = (v: string): v is View => v === "rendered" || v === "raw" || v === "compare";

function RevisionViewer({ revision, file }: { revision: Revision; file: FileDetail }) {
  const [view, setView] = useState<View>("rendered");
  const isHead = revision.version === file.version;
  const markdown = isMarkdown(file.mimeType);

  if (revision.content === undefined) {
    return (
      <Alert>
        <InfoIcon />
        <AlertDescription>
          The backend returned this revision&apos;s metadata only, so its content can&apos;t be shown.
        </AlertDescription>
      </Alert>
    );
  }

  // Fall back if the chosen view isn't available for this revision.
  const effective: View =
    (view === "compare" && isHead) || (view === "rendered" && !markdown) ? "raw" : view;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-semibold">Version {revision.version}</span>
        <ActorBadge actor={revision} />
        <span className="text-muted-foreground">{formatAbsolute(revision.createdAt)}</span>
        <Tabs value={effective} onValueChange={(v) => isView(v) && setView(v)} className="ml-auto">
          <TabsList>
            {markdown && <TabsTrigger value="rendered">Rendered</TabsTrigger>}
            <TabsTrigger value="raw">Raw</TabsTrigger>
            {!isHead && <TabsTrigger value="compare">Compare with current</TabsTrigger>}
          </TabsList>
        </Tabs>
      </div>

      {effective === "rendered" && (
        <div className="rounded-md border bg-card p-4">
          <MarkdownPreview content={revision.content} />
        </div>
      )}
      {effective === "raw" && (
        <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-4 font-mono text-xs leading-relaxed">
          {revision.content}
        </pre>
      )}
      {effective === "compare" && (
        <DiffView
          left={{ title: `Version ${revision.version}`, content: revision.content }}
          right={{ title: `Version ${file.version} (current)`, content: file.content ?? "" }}
        />
      )}
      <p className="text-xs text-muted-foreground">Read-only. Older versions are kept forever; nothing here changes the file.</p>
    </div>
  );
}

export default function HistoryPage() {
  const { workspaceId, fileId } = useParams<{ workspaceId: string; fileId: string }>();
  const api = useTandemApi();
  const load = useCallback(
    () => Promise.all([api.readFile(fileId), api.listRevisions(fileId)]),
    [api, fileId],
  );
  const { resource, reload } = useResource(load);
  const [selected, setSelected] = useState<number | null>(null);
  const fileHref = `/w/${workspaceId}/files/${fileId}`;

  if (resource.status === "loading") {
    return (
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <Skeleton className="h-7 w-64" />
        <div className="grid gap-6 md:grid-cols-[18rem_1fr]">
          <Skeleton className="h-64" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }

  if (resource.status === "error") {
    return (
      <div className="mx-auto max-w-2xl">
        <ErrorState error={resource.error} onRetry={reload} />
      </div>
    );
  }

  const [file, revisions] = resource.data;
  const current = revisions.find((r) => r.version === (selected ?? file.version)) ?? revisions[0];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <FileHeader
          workspaceId={workspaceId}
          name={file.name}
          mimeType={file.mimeType}
          trail={{ label: "History", fileHref }}
        />
        <Button variant="outline" size="sm" asChild>
          <Link href={fileHref}>
            <ArrowLeftIcon />
            Back to file
          </Link>
        </Button>
      </div>

      {revisions.length === 0 || !current ? (
        <p className="text-sm text-muted-foreground">No revisions recorded for this file.</p>
      ) : (
        <div className="grid gap-6 md:grid-cols-[18rem_1fr]">
          <RevisionList
            revisions={revisions}
            headVersion={file.version}
            selected={current.version}
            onSelect={setSelected}
          />
          <RevisionViewer key={current.version} revision={current} file={file} />
        </div>
      )}
    </div>
  );
}
