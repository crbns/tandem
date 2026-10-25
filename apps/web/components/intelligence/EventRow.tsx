"use client";

import Link from "next/link";
import { ArrowRightIcon, SparklesIcon } from "lucide-react";
import type { ActivityEvent } from "@/lib/api/types";
import { clientName } from "@/lib/actors";
import { resourceHref } from "@/lib/live";
import { formatAbsolute, formatRelative } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { CustodyMark } from "@/components/common/CustodyMark";
import { cn } from "@/lib/utils";
import { PayloadView, SourceBadge } from "./chips";
import { eventKind } from "./describe";

const INTEL_COPY: Record<ActivityEvent["intelStatus"], string> = {
  processed: "Processed by the context manager",
  pending: "Waiting for the context manager",
  skipped: "Not significant: the context manager skips it",
};

/**
 * One raw activity event: source, who, what, when, outcome. Expands in place
 * to the redacted payload and provenance ids.
 */
export function EventRow({
  event,
  workspaceId,
  open,
  onToggle,
  fresh = false,
}: {
  event: ActivityEvent;
  workspaceId: string;
  open: boolean;
  onToggle: () => void;
  fresh?: boolean;
}) {
  const now = useNow();
  const { icon: Icon, label } = eventKind(event);
  const failed = event.outcome !== "ok";
  const simulated = event.source === "simulator";
  const detailId = `event-${event.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <li
      className={cn(
        "border-b last:border-b-0",
        fresh && "animate-custody-in",
        event.outcome === "conflict" && "bg-destructive/[0.04] shadow-[inset_3px_0_0_var(--destructive)]",
        event.outcome === "error" && "bg-warn-tint/60 shadow-[inset_3px_0_0_var(--warn)]",
        simulated && "border-l border-dashed border-l-warn",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={onToggle}
        className={cn(
          "grid w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-x-2.5 px-4 py-2.5 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50",
          open && "bg-archive-tint hover:bg-archive-tint",
        )}
      >
        <Icon aria-hidden className={cn("mt-0.5 size-4", failed ? (event.outcome === "conflict" ? "text-destructive" : "text-warn") : "text-muted-foreground")} />
        <span className="min-w-0">
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <SourceBadge source={event.source} />
            <CustodyMark kind={event.actor.type === "system" ? "unknown" : event.actor.type} />
            <span className="truncate font-medium">{event.actor.label}</span>
            {event.actor.client && event.actor.type === "agent" && (
              <span className="shrink-0 text-xs text-muted-foreground">{clientName(event.actor.client)}</span>
            )}
            <span className="sr-only">, {label}</span>
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{event.summary}</span>
        </span>
        <span className="flex flex-col items-end gap-1">
          <time dateTime={new Date(event.occurredAt).toISOString()} title={formatAbsolute(event.occurredAt)} className="whitespace-nowrap text-xs text-muted-foreground">
            {formatRelative(event.occurredAt, now)}
          </time>
          <span className="flex items-center gap-1.5">
            {event.errorCode && (
              <span className={cn("label-caps", event.outcome === "conflict" ? "text-destructive" : "text-warn")}>
                {event.errorCode.replaceAll("_", " ")}
              </span>
            )}
            {event.intelStatus === "processed" && (
              <span title={INTEL_COPY.processed}>
                <SparklesIcon aria-hidden className="size-3.5 text-agent" />
                <span className="sr-only">{INTEL_COPY.processed}</span>
              </span>
            )}
            {event.intelStatus === "pending" && (
              <span title={INTEL_COPY.pending} className="size-2 rounded-full border border-dashed border-archive">
                <span className="sr-only">{INTEL_COPY.pending}</span>
              </span>
            )}
          </span>
        </span>
      </button>
      {open && (
        <div id={detailId} className="animate-custody-in flex flex-col gap-2 border-t bg-background/60 px-4 py-3 text-xs">
          <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">Type</dt>
            <dd className="min-w-0">
              {label} <code className="font-mono text-muted-foreground">{event.type}</code>
            </dd>
            {event.tool && (
              <>
                <dt className="text-muted-foreground">Tool</dt>
                <dd><code className="font-mono">{event.tool}</code></dd>
              </>
            )}
            <dt className="text-muted-foreground">Outcome</dt>
            <dd>{event.outcome === "ok" ? "Succeeded" : event.outcome === "conflict" ? "Conflict" : "Failed"}{event.errorCode ? ` (${event.errorCode})` : ""}</dd>
            <dt className="text-muted-foreground">When</dt>
            <dd>
              {formatAbsolute(event.occurredAt)}
              {Math.abs(event.createdAt - event.occurredAt) > 60_000 && (
                <span className="text-muted-foreground"> (received {formatRelative(event.createdAt, now)})</span>
              )}
            </dd>
            <dt className="text-muted-foreground">Context manager</dt>
            <dd>{INTEL_COPY[event.intelStatus]}</dd>
            {event.sessionId && (
              <>
                <dt className="text-muted-foreground">Session</dt>
                <dd className="truncate font-mono">{event.sessionId}</dd>
              </>
            )}
            {event.resources.map((resource) => {
              const href = resourceHref(workspaceId, resource);
              return (
                <div key={`${resource.type}:${resource.id}`} className="contents">
                  <dt className="text-muted-foreground">{resource.type === "file" ? "File" : "Resource"}</dt>
                  <dd className="min-w-0">
                    {href ? (
                      <Link href={href} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                        {resource.label ?? resource.type}
                        <ArrowRightIcon aria-hidden className="size-3.5" />
                      </Link>
                    ) : (
                      (resource.label ?? resource.type)
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
          {simulated && <p className="text-warn">Simulated event for development replay: no real assistant did this.</p>}
          <PayloadView payload={event.payload} />
        </div>
      )}
    </li>
  );
}
