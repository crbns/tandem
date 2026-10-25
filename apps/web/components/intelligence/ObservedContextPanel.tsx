"use client";

import { useMemo, useState } from "react";
import { FileTextIcon, Loader2Icon, RotateCwIcon } from "lucide-react";
import { toast } from "sonner";
import { normalizeError, useTandemApi } from "@/lib/api";
import { ERROR_COPY } from "@/lib/api/errorCopy";
import type { ObservedContext } from "@/lib/api/types";
import { useObservedContext } from "@/lib/api/useIntelligence";
import { useWorkspaceRole } from "@/lib/api/useWorkspace";
import { formatAbsolute, formatRelative } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { ErrorState } from "@/components/common/ErrorState";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { GROUPS, groupEntries, isCurrent } from "./describe";
import { EntryCard } from "./EntryCard";

/**
 * "What the team is doing": the context manager's observed state, grouped,
 * with evidence on every entry and a status line for the manager itself.
 * Derived from activity and documents; not project context.
 */
export function ObservedContextPanel({
  workspaceId,
  onOpenHistory,
}: {
  workspaceId: string;
  onOpenHistory: (entryId: string) => void;
}) {
  const { resource, retry } = useObservedContext(workspaceId);
  const groups = useMemo(() => (resource.status === "ready" ? groupEntries(resource.data.entries) : null), [resource]);
  const hidden = resource.status === "ready" ? resource.data.entries.filter((e) => !isCurrent(e)).length : 0;

  return (
    <section aria-labelledby="observed-context" className="flex flex-col gap-4 rounded-md border bg-card px-5 py-4">
      <div className="flex flex-col gap-1">
        <h2 id="observed-context" className="text-base font-semibold">
          What the team is doing
        </h2>
        <p className="max-w-3xl text-xs text-muted-foreground">
          Observed by Tandem&apos;s context manager from recorded activity and documents. It is not project context;
          goals, decisions and owners need a person&apos;s direction. Assistants receive this on their
          next sync.
        </p>
      </div>
      {resource.status === "loading" && (
        <>
          <Skeleton className="h-6 w-96 max-w-full" />
          <Skeleton className="h-64" aria-label="Loading observed context" />
        </>
      )}
      {resource.status === "error" && <ErrorState error={resource.error} onRetry={retry} />}
      {resource.status === "ready" && groups && (
        <>
          <ManagerStatus workspaceId={workspaceId} observed={resource.data} />
          {resource.data.entries.length === 0 ? (
            <p className="rounded-md border border-dashed px-6 py-10 text-center text-sm text-muted-foreground">
              Nothing observed yet. As assistants call Tandem tools, Claude Code hooks report, and people edit files,
              the context manager summarizes the work here.
            </p>
          ) : (
            <div className="grid gap-x-5 gap-y-4 md:grid-cols-2 2xl:grid-cols-4">
              {GROUPS.map((group) => {
                const entries = groups.get(group.key)!;
                return (
                  <section key={group.key} aria-labelledby={`group-${group.key}`} className="flex min-w-0 flex-col gap-2">
                    <h3 id={`group-${group.key}`} className="label-caps flex items-center gap-1.5 text-muted-foreground">
                      {group.label}
                      <span className="tabular-nums">{entries.length}</span>
                    </h3>
                    {entries.length === 0 ? (
                      <p className="text-xs text-muted-foreground">{group.empty}</p>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {entries.map((entry) => (
                          <EntryCard key={entry.id} entry={entry} workspaceId={workspaceId} onOpenHistory={onOpenHistory} />
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}
          {hidden > 0 && (
            <p className="text-xs text-muted-foreground">
              {hidden} retracted or superseded {hidden === 1 ? "entry is" : "entries are"} kept in the change history.
            </p>
          )}
        </>
      )}
    </section>
  );
}

const STATUS_COPY: Record<ObservedContext["status"], string> = {
  idle: "Idle",
  scheduled: "Batch scheduled",
  running: "Processing activity",
};

function ManagerStatus({ workspaceId, observed }: { workspaceId: string; observed: ObservedContext }) {
  const api = useTandemApi();
  const now = useNow();
  const role = useWorkspaceRole(workspaceId);
  const [retrying, setRetrying] = useState(false);
  const [reading, setReading] = useState(false);
  const canRetry = role === "owner" || role === "admin";
  const failing = observed.consecutiveFailures > 0;
  const last = observed.lastRun;
  const retry = async () => {
    setRetrying(true);
    try {
      const { scheduled } = await api.retryContextManager(workspaceId);
      toast.success(scheduled ? "Context manager scheduled." : "Backoff cleared; the running batch will pick up pending events.");
    } catch (err) {
      toast.error(ERROR_COPY[normalizeError(err).code].title);
    } finally {
      setRetrying(false);
    }
  };
  const readDocuments = async () => {
    setReading(true);
    try {
      const { queued, more } = await api.backfillDocuments(workspaceId);
      toast.success(
        queued || more
          ? `Reading ${queued}${more ? "+" : ""} document${queued === 1 && !more ? "" : "s"}.`
          : "Every document is already read at its current version.",
      );
    } catch (err) {
      toast.error(ERROR_COPY[normalizeError(err).code].title);
    } finally {
      setReading(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-sm border px-3 py-2 text-xs",
          failing ? "border-warn-rule bg-warn-tint" : "bg-background/60",
        )}
      >
        <span className="inline-flex items-center gap-1.5 font-medium">
          {observed.status === "idle" ? (
            <span aria-hidden className="size-2 rounded-full bg-unknown" />
          ) : (
            <Loader2Icon aria-hidden className="size-3.5 animate-spin text-agent" />
          )}
          Context manager: {STATUS_COPY[observed.status]}
        </span>
        <span className="text-muted-foreground">
          Last run{" "}
          {observed.lastRunAt ? (
            <time dateTime={new Date(observed.lastRunAt).toISOString()} title={formatAbsolute(observed.lastRunAt)}>
              {formatRelative(observed.lastRunAt, now)}
            </time>
          ) : (
            "never"
          )}
          {last && ` · ${last.method === "llm" ? (last.model ?? "model") : "heuristic"}${last.status === "failed" ? " (failed)" : ""}`}
        </span>
        <span className="text-muted-foreground">
          {observed.pendingEvents > 100 ? "100+" : observed.pendingEvents} pending event{observed.pendingEvents === 1 ? "" : "s"}
        </span>
        <span className="text-muted-foreground">Revision {observed.revision}</span>
        {failing && (
          <span className="font-medium text-warn">
            {observed.consecutiveFailures} failed run{observed.consecutiveFailures === 1 ? "" : "s"}
            {observed.nextRetryAt && observed.nextRetryAt > now ? `, retrying ${formatAbsolute(observed.nextRetryAt)}` : ""}
          </span>
        )}
        {canRetry && (
          <Button variant="ghost" size="sm" className="ml-auto h-7 text-xs" onClick={() => void readDocuments()} disabled={reading}>
            {reading ? <Loader2Icon className="animate-spin" /> : <FileTextIcon />}
            Read existing documents
          </Button>
        )}
        {canRetry && (
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => void retry()} disabled={retrying || observed.status === "running"}>
            {retrying ? <Loader2Icon className="animate-spin" /> : <RotateCwIcon />}
            {failing ? "Retry now" : "Run now"}
          </Button>
        )}
      </div>
      {last?.status === "failed" && last.error && <p className="text-xs text-warn">Last run failed: {last.error}</p>}
      {last?.method === "heuristic" && (
        <p className="text-xs text-muted-foreground">
          Heuristic mode: no ANTHROPIC_API_KEY is set on the deployment, so entries come from simple rules instead of
          the model. Evidence labels still apply.
        </p>
      )}
    </div>
  );
}
