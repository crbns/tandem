"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeftIcon, InfoIcon } from "lucide-react";
import { TandemApiError, useTandemApi, type FileDetail, type Revision } from "@/lib/api";
import { useResource } from "@/lib/api/useResource";
import { belongsToWorkspace, isMarkdown } from "@/lib/files";
import { formatAbsolute } from "@/lib/time";
import { FileHeader } from "@/components/files/FileHeader";
import { RevisionList } from "@/components/history/RevisionList";
import { MarkdownPreview } from "@/components/editor/MarkdownPreview";
import { ActorBadge } from "@/components/common/ActorBadge";
import { DiffView } from "@/components/common/DiffView";
import { ErrorState } from "@/components/common/ErrorState";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";

type View = "changes" | "rendered" | "raw" | "compare";

interface RevisionViewerProps {
  revision: Revision;
  /** The version before this one, if any (for "Changes in this version"). */
  previous: Revision | undefined;
  /** The current version, i.e. the newest revision. */
  head: { version: number; content: string };
  file: FileDetail;
}

function RevisionViewer({ revision, previous, head, file }: RevisionViewerProps) {
  const isHead = revision.version === head.version;
  const markdown = isMarkdown(file.mimeType);
  const canShowChanges = previous?.content !== undefined;
  const [view, setView] = useState<View>(canShowChanges ? "changes" : markdown ? "rendered" : "raw");

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

  const options: Array<{ value: View; label: string }> = [
    ...(canShowChanges ? [{ value: "changes" as const, label: "Changes in this version" }] : []),
    ...(markdown ? [{ value: "rendered" as const, label: "Rendered" }] : []),
    { value: "raw", label: "Raw" },
    ...(!isHead ? [{ value: "compare" as const, label: "Compare with current" }] : []),
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-semibold">Version {revision.version}</span>
        <ActorBadge actor={revision} />
        <span className="text-muted-foreground">{formatAbsolute(revision.createdAt)}</span>
        <SegmentedControl
          label="Revision view"
          value={view}
          options={options}
          onChange={setView}
          className="ml-auto"
        />
      </div>

      {view === "changes" && previous?.content !== undefined && (
        <DiffView
          left={{ title: `Version ${previous.version}`, content: previous.content }}
          right={{ title: `Version ${revision.version}`, content: revision.content }}
        />
      )}
      {view === "rendered" && (
        <div className="rounded-md border bg-card p-4">
          <MarkdownPreview content={revision.content} />
        </div>
      )}
      {view === "raw" && (
        <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-4 font-mono text-xs leading-relaxed">
          {revision.content}
        </pre>
      )}
      {view === "compare" && (
        <DiffView
          left={{ title: `Version ${revision.version}`, content: revision.content }}
          right={{ title: `Version ${head.version} (current)`, content: head.content }}
        />
      )}
      <p className="text-xs text-muted-foreground">
        Read-only. Older versions are kept forever; nothing here changes the file.
      </p>
    </div>
  );
}

export default function HistoryPage() {
  const { workspaceId, fileId } = useParams<{ workspaceId: string; fileId: string }>();
  const api = useTandemApi();
  const load = useCallback(async () => {
    const [file, revisions] = await Promise.all([api.readFile(fileId), api.listRevisions(fileId)]);
    if (!belongsToWorkspace(file, workspaceId)) throw new TandemApiError("FILE_NOT_FOUND");
    return [file, revisions] as const;
  }, [api, fileId, workspaceId]);
  const { resource, refreshing, reload } = useResource(load);
  const [selected, setSelected] = useState<number | null>(null);
  const fileHref = `/w/${workspaceId}/files/${fileId}`;

  if (resource.status === "loading") {
    return (
      <div className="mx-auto flex max-w-6xl flex-col gap-4" aria-busy="true">
        <Skeleton className="h-7 w-64" />
        <div className="grid gap-6 xl:grid-cols-[17rem_minmax(0,1fr)]">
          <Skeleton className="h-64" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }

  if (resource.status === "error") {
    return (
      <div className="mx-auto max-w-2xl">
        <ErrorState error={resource.error} onRetry={reload} retrying={refreshing} />
      </div>
    );
  }

  const [file, revisions] = resource.data;
  // The file and its revisions are separate reads, so an edit landing between
  // them can leave `file` a version behind. The list is newest first: trust it.
  const newest = revisions[0];
  const head = {
    version: newest?.version ?? file.version,
    content: newest && newest.version !== file.version ? (newest.content ?? "") : (file.content ?? ""),
  };
  const currentIndex = Math.max(
    0,
    revisions.findIndex((r) => r.version === (selected ?? head.version)),
  );
  const current = revisions[currentIndex];
  const previous = revisions[currentIndex + 1]; // newest first

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <FileHeader
          workspaceId={workspaceId}
          fileId={file.id}
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

      {!current ? (
        <p className="text-sm text-muted-foreground">No revisions recorded for this file.</p>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[17rem_minmax(0,1fr)]">
          <RevisionList
            revisions={revisions}
            headVersion={head.version}
            selected={current.version}
            onSelect={setSelected}
          />
          <RevisionViewer key={current.version} revision={current} previous={previous} head={head} file={file} />
        </div>
      )}
    </div>
  );
}
