"use client";

import { useMemo, useState } from "react";
import { Loader2Icon } from "lucide-react";
import type { ActivitySource, NetworkAgent } from "@/lib/api/types";
import { useActivityEvents } from "@/lib/api/useIntelligence";
import { ERROR_COPY } from "@/lib/api/errorCopy";
import { ErrorState } from "@/components/common/ErrorState";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { EventRow } from "@/components/intelligence/EventRow";
import { SOURCE_FILTERS } from "@/components/intelligence/describe";

type SourceFilter = (typeof SOURCE_FILTERS)[number]["value"];

/**
 * Every raw activity event Tandem recorded, newest first: MCP calls, Claude
 * Code hooks, workspace changes and simulated replay. The input the context
 * manager reads; rows expand to their redacted payload.
 */
export function ActivityFeed({
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
  const [source, setSource] = useState<SourceFilter>("all");
  const sources = useMemo<ActivitySource[]>(() => (source === "all" ? [] : [source]), [source]);
  const { state, loadMore, loadingMore, loadMoreError, retry } = useActivityEvents(workspaceId, sources, connectionId);
  const [openId, setOpenId] = useState<string | null>(null);
  const items = state.status === "ready" ? state.data.items : [];
  const filtered = source !== "all" || connectionId !== null;

  return (
    <section aria-labelledby="live-feed" className="flex min-h-0 flex-col rounded-md border bg-card">
      <div className="flex flex-col gap-3 border-b px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <h2 id="live-feed" className="text-base font-semibold">
            All activity
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
        <SegmentedControl label="Source" value={source} options={SOURCE_FILTERS} onChange={setSource} className="h-auto max-w-full flex-wrap" />
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
              ? "Nothing matches these filters in recent activity."
              : "No activity recorded yet. MCP calls, Claude Code hooks and file changes appear here as Tandem receives them."}
          </p>
          {state.data.nextBefore !== null && <LoadMore onClick={() => void loadMore()} loading={loadingMore} error={loadMoreError?.code ?? null} />}
        </div>
      )}
      {state.status === "ready" && items.length > 0 && (
        <ol aria-label="All activity, newest first" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {items.map((event) => (
            <EventRow
              key={event.id}
              event={event}
              workspaceId={workspaceId}
              fresh={state.data.fresh.has(event.id)}
              open={openId === event.id}
              onToggle={() => setOpenId((id) => (id === event.id ? null : event.id))}
            />
          ))}
          {(state.data.nextBefore !== null || loadMoreError) && (
            <li className="flex flex-col items-center gap-2 px-4 py-3">
              <LoadMore onClick={() => void loadMore()} loading={loadingMore} error={loadMoreError?.code ?? null} />
            </li>
          )}
        </ol>
      )}
    </section>
  );
}

function LoadMore({ onClick, loading, error }: { onClick: () => void; loading: boolean; error: keyof typeof ERROR_COPY | null }) {
  return (
    <>
      {error && <p className="text-xs text-destructive">{ERROR_COPY[error].title}</p>}
      <Button variant="outline" size="sm" onClick={onClick} disabled={loading}>
        {loading && <Loader2Icon className="animate-spin" />}
        Load more
      </Button>
    </>
  );
}
