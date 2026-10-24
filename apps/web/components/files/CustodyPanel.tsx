"use client";

import { useCallback } from "react";
import Link from "next/link";
import { useTandemApi, type FileSummary } from "@/lib/api";
import { useResource } from "@/lib/api/useResource";
import { displayId } from "@/lib/files";
import { formatAbsolute, formatRelative } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { ActorBadge } from "@/components/common/ActorBadge";
import { CustodyMark } from "@/components/common/CustodyMark";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { fileHref } from "@/components/files/FileTable";

const SHOWN = 6;

/** The selected file's chain of custody, newest first, without leaving the register. */
export function CustodyPanel({ workspaceId, file }: { workspaceId: string; file: FileSummary }) {
  const api = useTandemApi();
  const now = useNow();
  const load = useCallback(() => api.listRevisions(file.id), [api, file.id]);
  const { resource } = useResource(load);
  const href = fileHref(workspaceId, file.id);

  return (
    <aside
      aria-label={`Custody record for ${file.name}`}
      className="animate-custody-in rounded-md border bg-card p-5"
      aria-live="polite"
    >
      <h2 className="text-base font-bold leading-6">Custody record</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{file.name}</span>
        <span className="label-caps ml-2">{displayId(file.id)}</span>
      </p>

      {resource.status === "loading" && (
        <div className="mt-4 flex flex-col gap-3">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      )}
      {resource.status === "error" && (
        <p className="mt-4 text-sm text-muted-foreground">Couldn&apos;t load this file&apos;s history.</p>
      )}
      {resource.status === "ready" && (
        <ol className="mt-4 border-l-2 border-border">
          {resource.data.slice(0, SHOWN).map((rev, i) => (
            <li key={rev.version} className="relative pb-4 pl-4 last:pb-1">
              <CustodyMark kind={rev.actorType} size="lg" className="absolute -left-[7px] top-1" />
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="label-caps">v{rev.version}</span>
                {i === 0 && <span className="label-caps text-archive">Current</span>}
                <ActorBadge actor={rev} />
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground" title={formatAbsolute(rev.createdAt)}>
                {/* Agents only write through MCP; people only through the dashboard. */}
                Saved {rev.actorType === "agent" ? "via MCP" : "in the dashboard"} ·{" "}
                {formatRelative(rev.createdAt, now)}
              </p>
            </li>
          ))}
          {resource.data.length > SHOWN && (
            <li className="pl-4 text-xs text-muted-foreground">
              {resource.data.length - SHOWN} earlier versions in history
            </li>
          )}
        </ol>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button asChild size="sm">
          <Link href={href}>Open file</Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href={`${href}/history`}>Full history</Link>
        </Button>
      </div>
    </aside>
  );
}
