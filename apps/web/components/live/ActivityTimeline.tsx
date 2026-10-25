"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { ArrowRightIcon, Loader2Icon } from "lucide-react";
import type { NetworkAgent, TimelineItem } from "@/lib/api/types";
import type { TandemApiError } from "@/lib/api/errors";
import { useTimeline } from "@/lib/api/useLive";
import { ERROR_COPY } from "@/lib/api/errorCopy";
import { clientName } from "@/lib/actors";
import { FILTER_GROUPS, KIND_META, kindsFor, resourceHref, type FilterGroup } from "@/lib/live";
import { formatAbsolute, formatRelative } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { CustodyMark } from "@/components/common/CustodyMark";
import { ErrorState } from "@/components/common/ErrorState";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { KIND_STYLE } from "./kinds";
import { cn } from "@/lib/utils";

/**
 * Newest first: every MCP call the assistants made, and the decisions and
 * edits people made, filterable by assistant and by type. A row opens its
 * record in place.
 */
export function ActivityTimeline({
  workspaceId,
  agents,
  connectionId,
  onConnectionChange,
}: {
  workspaceId: string;
  agents: NetworkAgent[];
  connectionId: string | null;
  onConnectionChange: (connectionId: string | null) => void;
}) {
  const [group, setGroup] = useState<FilterGroup>("all");
  const kinds = useMemo(() => kindsFor(group), [group]);
  const { state, loadMore, loadingMore, loadMoreError, retry } = useTimeline(workspaceId, connectionId, kinds);
  const [openId, setOpenId] = useState<string | null>(null);
  const items = useMemo(() => (state.status === "ready" ? state.data.items : []), [state]);
  // Conflict id → the later save that resolved it.
  const resolvers = useMemo(() => new Map(items.flatMap((item) => (item.resolvesId ? [[item.resolvesId, item] as const] : []))), [items]);
  const loadedIds = useMemo(() => new Set(items.map((item) => item.id)), [items]);
  const filtered = connectionId !== null || group !== "all";

  return (
    <section aria-labelledby="live-timeline" className="flex min-h-0 flex-col rounded-md border bg-card">
      <div className="flex flex-col gap-3 border-b px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <h2 id="live-timeline" className="text-base font-semibold">
            Activity
          </h2>
          <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="sr-only sm:not-sr-only">Assistant</span>
            <select
              value={connectionId ?? ""}
              onChange={(e) => onConnectionChange(e.target.value || null)}
              className="h-8 min-w-0 max-w-48 truncate rounded-md border border-input bg-card px-2 text-xs text-foreground shadow-xs outline-none focus-visible:border-archive focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <option value="">Everyone</option>
              {agents.map((agent) => (
                <option key={agent.connectionId} value={agent.connectionId}>
                  {agent.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <SegmentedControl
          label="Activity type"
          value={group}
          options={FILTER_GROUPS}
          onChange={setGroup}
          className="h-auto max-w-full flex-wrap"
        />
      </div>

      {state.status === "loading" && (
        <div className="flex flex-col gap-2 p-4" aria-label="Loading activity">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      )}
      {state.status === "error" && (
        <div className="p-4">
          <ErrorState error={state.error} onRetry={retry} />
        </div>
      )}
      {state.status === "ready" && items.length === 0 && (
        <div className="flex flex-col items-center gap-3 px-4 py-10 text-center text-sm text-muted-foreground">
          <p>
            {filtered
              ? state.data.nextBefore !== null
                ? "Nothing matches these filters in recent activity."
                : "Nothing matches these filters yet."
              : "No activity yet. It appears here as soon as an assistant calls a Tandem tool."}
          </p>
          {state.data.nextBefore !== null && (
            <LoadMore onClick={() => void loadMore()} loading={loadingMore} error={loadMoreError} />
          )}
        </div>
      )}
      {state.status === "ready" && items.length > 0 && (
        <ol aria-label="Activity, newest first" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {items.map((item) => (
            <TimelineRow
              key={item.id}
              item={item}
              workspaceId={workspaceId}
              fresh={state.data.fresh.has(item.id)}
              open={openId === item.id}
              onToggle={() => setOpenId((id) => (id === item.id ? null : item.id))}
              resolvedBy={resolvers.get(item.id) ?? null}
              onJump={setOpenId}
              loaded={(id) => loadedIds.has(id)}
            />
          ))}
          {(state.data.nextBefore !== null || loadMoreError) && (
            <li className="flex flex-col items-center gap-2 px-4 py-3">
              <LoadMore onClick={() => void loadMore()} loading={loadingMore} error={loadMoreError} />
            </li>
          )}
        </ol>
      )}
    </section>
  );
}

function LoadMore({ onClick, loading, error }: { onClick: () => void; loading: boolean; error: TandemApiError | null }) {
  return (
    <>
      {error && <p className="text-xs text-destructive">{ERROR_COPY[error.code].title}</p>}
      <Button variant="outline" size="sm" onClick={onClick} disabled={loading}>
        {loading && <Loader2Icon className="animate-spin" />}
        Load more
      </Button>
    </>
  );
}

function TimelineRow({
  item,
  workspaceId,
  fresh,
  open,
  onToggle,
  resolvedBy,
  onJump,
  loaded,
}: {
  item: TimelineItem;
  workspaceId: string;
  fresh: boolean;
  open: boolean;
  onToggle: () => void;
  resolvedBy: TimelineItem | null;
  onJump: (id: string) => void;
  loaded: (id: string) => boolean;
}) {
  const now = useNow();
  const style = KIND_STYLE[item.kind];
  const Icon = style.icon;
  const conflict = item.kind === "conflict" || item.kind === "error";
  const decision = item.kind === "approve" || item.kind === "reject";
  const detailId = `live-item-${item.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <li
      className={cn(
        "border-b last:border-b-0",
        fresh && "animate-custody-in",
        item.kind === "conflict" && "bg-destructive/[0.04] shadow-[inset_3px_0_0_var(--destructive)]",
        item.kind === "error" && "bg-warn-tint/60 shadow-[inset_3px_0_0_var(--warn)]",
        decision && "bg-human-tint/50 shadow-[inset_3px_0_0_var(--human)]",
        item.kind === "resolved" && "shadow-[inset_3px_0_0_var(--agent)]",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={onToggle}
        className={cn(
          "grid w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-x-2.5 px-4 py-2.5 text-left transition-colors hover:bg-accent/60",
          open && "bg-archive-tint hover:bg-archive-tint",
        )}
      >
        <Icon aria-hidden className={cn("mt-0.5 size-4", style.text)} />
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-1.5">
            <CustodyMark kind={item.actor.type === "system" ? "unknown" : item.actor.type} />
            <span className="truncate font-medium">{item.actor.label}</span>
            <span className={cn("shrink-0 text-xs font-medium", conflict || decision ? style.text : "text-muted-foreground")}>
              {KIND_META[item.kind].label}
            </span>
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{item.summary}</span>
        </span>
        <span className="flex flex-col items-end gap-1">
          <time dateTime={new Date(item.createdAt).toISOString()} title={formatAbsolute(item.createdAt)} className="whitespace-nowrap text-xs text-muted-foreground">
            {formatRelative(item.createdAt, now)}
          </time>
          {item.errorCode && <span className={cn("label-caps", style.text)}>{item.errorCode.replaceAll("_", " ")}</span>}
        </span>
      </button>
      {open && (
        <TimelineDetail id={detailId} item={item} workspaceId={workspaceId} resolvedBy={resolvedBy} onJump={onJump} loaded={loaded} />
      )}
    </li>
  );
}

function outcomeCopy(item: TimelineItem): string {
  if (item.outcome === "conflict") return "Conflict: nothing was saved";
  if (item.outcome === "error") return "Failed: nothing was saved";
  return "Succeeded";
}

function resourceLabel(resource: NonNullable<TimelineItem["resource"]>): string {
  switch (resource.type) {
    case "file":
    case "folder":
      return `Open ${resource.label ?? resource.type}`;
    case "proposal":
      return "Open approvals";
    case "context":
    case "published_work":
      return "Open project context";
    case "task":
      return resource.label ?? "Task";
    default:
      return resource.label ?? resource.type;
  }
}

function TimelineDetail({
  id,
  item,
  workspaceId,
  resolvedBy,
  onJump,
  loaded,
}: {
  id: string;
  item: TimelineItem;
  workspaceId: string;
  resolvedBy: TimelineItem | null;
  onJump: (id: string) => void;
  loaded: (id: string) => boolean;
}) {
  const href = resourceHref(workspaceId, item.resource);
  const rows: Array<[string, ReactNode]> = [
    ["When", formatAbsolute(item.createdAt)],
    [
      "Who",
      <span key="who" className="inline-flex min-w-0 items-center gap-1.5">
        <CustodyMark kind={item.actor.type === "system" ? "unknown" : item.actor.type} />
        <span className={cn("label-caps", item.actor.type === "agent" ? "text-agent" : item.actor.type === "human" ? "text-human" : "text-muted-foreground")}>
          {item.actor.type === "agent" ? "Agent" : item.actor.type === "human" ? "Human" : "System"}
        </span>
        <span className="truncate">
          {item.actor.label}
          {item.actor.client && <span className="text-muted-foreground"> ({clientName(item.actor.client)})</span>}
        </span>
      </span>,
    ],
  ];
  if (item.tool) rows.push(["Tool", <code key="tool" className="font-mono text-xs">{item.tool}</code>]);
  rows.push(["Outcome", item.errorCode ? `${outcomeCopy(item)} (${item.errorCode})` : outcomeCopy(item)]);
  if (item.kind === "sync" && item.contextRevision !== null) {
    rows.push([
      "Context",
      item.previousSyncedContextRevision === null
        ? `Received v${item.contextRevision} (first sync)`
        : item.previousSyncedContextRevision === item.contextRevision
          ? `Received v${item.contextRevision} (unchanged)`
          : `Received v${item.contextRevision} (had v${item.previousSyncedContextRevision})`,
    ]);
  } else if (item.contextRevision !== null && item.contextRevision > 0) {
    rows.push(["Context", `v${item.contextRevision} was approved at the time`]);
  }
  if (item.resource) {
    rows.push([
      "Resource",
      href ? (
        <Link key="res" href={href} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
          {resourceLabel(item.resource)}
          <ArrowRightIcon className="size-3.5" aria-hidden />
        </Link>
      ) : (
        resourceLabel(item.resource)
      ),
    ]);
  }
  if (item.resolvesId) {
    const resolves = item.resolvesId;
    rows.push([
      "Resolves",
      loaded(resolves) ? (
        <button key="resolves" type="button" onClick={() => onJump(resolves)} className="font-medium text-primary hover:underline">
          Show the conflict this save fixed
        </button>
      ) : (
        "An earlier conflict by this assistant"
      ),
    ]);
  }
  if (resolvedBy) {
    rows.push([
      "Resolved",
      <button key="resolved" type="button" onClick={() => onJump(resolvedBy.id)} className="font-medium text-primary hover:underline">
        Show the save that fixed it
      </button>,
    ]);
  }
  return (
    <div id={id} className="animate-custody-in border-t bg-background/60 px-4 py-3">
      <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
        {rows.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="min-w-0">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
