"use client";

import { CircleAlertIcon, CircleCheckIcon, CircleDashedIcon, Loader2Icon } from "lucide-react";
import type { ContextChange, IntelRun } from "@/lib/api/types";
import { useContextChanges } from "@/lib/api/useIntelligence";
import { formatAbsolute, formatRelative } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { CustodyMark } from "@/components/common/CustodyMark";
import { ErrorState } from "@/components/common/ErrorState";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { EvidenceChip } from "./chips";
import { describeChange } from "./describe";

/**
 * How the observed context changed, newest first, one sentence each; a row
 * opens the entry's history and evidence. Below it, the context manager's
 * recent runs ("processing").
 */
export function ContextChangeHistory({
  workspaceId,
  onOpenHistory,
}: {
  workspaceId: string;
  onOpenHistory: (entryId: string) => void;
}) {
  const { resource, retry } = useContextChanges(workspaceId);
  return (
    <section aria-labelledby="context-changes" className="flex min-h-0 flex-col rounded-md border bg-card">
      <div className="border-b px-4 py-3">
        <h2 id="context-changes" className="text-base font-semibold">
          Context change history
        </h2>
        <p className="text-xs text-muted-foreground">Open a change to see the evidence behind it.</p>
      </div>
      {resource.status === "loading" && (
        <div className="flex flex-col gap-2 p-4" aria-label="Loading changes">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      )}
      {resource.status === "error" && (
        <div className="p-4">
          <ErrorState error={resource.error} onRetry={retry} />
        </div>
      )}
      {resource.status === "ready" && (
        <>
          {resource.data.changes.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">No observed changes yet.</p>
          ) : (
            <ol aria-label="Context changes, newest first" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {resource.data.changes.map((change) => (
                <ChangeRow key={change.id} change={change} onOpen={() => onOpenHistory(change.entryId)} />
              ))}
            </ol>
          )}
          {resource.data.runs.length > 0 && <RunLane runs={resource.data.runs} />}
        </>
      )}
    </section>
  );
}

function ChangeRow({ change, onOpen }: { change: ContextChange; onOpen: () => void }) {
  const now = useNow();
  const human = change.actor.type === "human";
  return (
    <li className="border-b last:border-b-0">
      <button
        type="button"
        onClick={onOpen}
        aria-haspopup="dialog"
        className={cn(
          "grid w-full grid-cols-[0.5rem_minmax(0,1fr)_auto] items-start gap-x-2.5 px-4 py-2.5 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50",
          human && "bg-human-tint/40",
        )}
      >
        <CustodyMark kind={human ? "human" : "unknown"} className="mt-1.5" />
        <span className="min-w-0">
          <span className="block text-sm font-medium leading-5">{describeChange(change)}</span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{change.title}</span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5">
            <EvidenceChip evidence={change.evidence} />
            {change.reason && <span className="truncate text-[0.6875rem] text-muted-foreground">{change.reason}</span>}
          </span>
        </span>
        <time dateTime={new Date(change.createdAt).toISOString()} title={formatAbsolute(change.createdAt)} className="whitespace-nowrap text-xs text-muted-foreground">
          {formatRelative(change.createdAt, now)}
        </time>
      </button>
    </li>
  );
}

const RUN_ICON: Record<IntelRun["status"], { icon: typeof CircleCheckIcon; className: string; label: string }> = {
  running: { icon: Loader2Icon, className: "animate-spin text-agent", label: "Running" },
  succeeded: { icon: CircleCheckIcon, className: "text-agent", label: "Succeeded" },
  failed: { icon: CircleAlertIcon, className: "text-warn", label: "Failed" },
  skipped: { icon: CircleDashedIcon, className: "text-muted-foreground", label: "Skipped" },
};

function RunLane({ runs }: { runs: IntelRun[] }) {
  const now = useNow();
  return (
    <details className="group border-t">
      <summary className="cursor-pointer list-none px-4 py-2.5 text-xs font-medium text-muted-foreground hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50">
        Processing: last {runs.length} context-manager run{runs.length === 1 ? "" : "s"}
        <span aria-hidden className="ml-1 inline-block transition-transform group-open:rotate-90">›</span>
      </summary>
      <ol className="flex flex-col gap-1.5 px-4 pb-3">
        {runs.map((run) => {
          const meta = RUN_ICON[run.status];
          const Icon = meta.icon;
          return (
            <li key={run.id} className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-x-2 text-xs">
              <Icon aria-label={meta.label} className={cn("mt-0.5 size-3.5", meta.className)} />
              <span className="min-w-0">
                <span className="block truncate">{run.error ?? run.summary ?? `${run.eventCount} events`}</span>
                <span className="text-[0.6875rem] text-muted-foreground">
                  {run.method === "llm" ? (run.model ?? "model") : "heuristic"} · {run.eventCount} event{run.eventCount === 1 ? "" : "s"}
                  {run.contextChanges > 0 && ` · ${run.contextChanges} project context change${run.contextChanges === 1 ? "" : "s"}`}
                </span>
              </span>
              <time dateTime={new Date(run.startedAt).toISOString()} title={formatAbsolute(run.startedAt)} className="whitespace-nowrap text-muted-foreground">
                {formatRelative(run.startedAt, now)}
              </time>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
