"use client";

import { useState } from "react";
import type { ContextChange } from "@/lib/api/types";
import { useEntryHistory } from "@/lib/api/useIntelligence";
import { formatAbsolute } from "@/lib/time";
import { ErrorState } from "@/components/common/ErrorState";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { CustodyMark } from "@/components/common/CustodyMark";
import { Confidence, EvidenceChip } from "./chips";
import { CATEGORY_NOUN, describeChange } from "./describe";
import { EventRow } from "./EventRow";

/**
 * Provenance for one observed entry: every revision with who or which run
 * made it and why, and the recorded activity events it cites.
 */
export function EntryHistoryDialog({
  workspaceId,
  entryId,
  onClose,
}: {
  workspaceId: string;
  entryId: string | null;
  onClose: () => void;
}) {
  const { resource, retry } = useEntryHistory(workspaceId, entryId);
  const [openEvent, setOpenEvent] = useState<string | null>(null);
  return (
    <Dialog open={entryId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{resource.status === "ready" ? resource.data.entry.title : "Entry history"}</DialogTitle>
          <DialogDescription>
            {resource.status === "ready"
              ? `Observed ${CATEGORY_NOUN[resource.data.entry.category]}, revision ${resource.data.entry.revision}. Observed context is derived from activity; it is not project context.`
              : "How this observed entry changed, and the activity behind it."}
          </DialogDescription>
        </DialogHeader>
        {resource.status === "loading" && <Skeleton className="h-48" aria-label="Loading history" />}
        {resource.status === "error" && <ErrorState error={resource.error} onRetry={retry} />}
        {resource.status === "ready" && (
          <div className="flex flex-col gap-5">
            <section aria-labelledby="entry-revisions" className="flex flex-col gap-2">
              <h3 id="entry-revisions" className="label-caps text-muted-foreground">Revisions</h3>
              <ol className="flex flex-col gap-2">
                {resource.data.revisions.map((change) => (
                  <RevisionItem key={change.id} change={change} />
                ))}
              </ol>
            </section>
            <section aria-labelledby="entry-evidence" className="flex flex-col gap-2">
              <h3 id="entry-evidence" className="label-caps text-muted-foreground">
                Evidence ({resource.data.evidence.length})
              </h3>
              {resource.data.evidence.length === 0 ? (
                <p className="text-sm text-muted-foreground">No recorded events are cited. Entries confirmed by a person or seeded from project context have none.</p>
              ) : (
                <ol className="overflow-hidden rounded-sm border">
                  {resource.data.evidence.map((event) => (
                    <EventRow
                      key={event.id}
                      event={event}
                      workspaceId={workspaceId}
                      open={openEvent === event.id}
                      onToggle={() => setOpenEvent((id) => (id === event.id ? null : event.id))}
                    />
                  ))}
                </ol>
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RevisionItem({ change }: { change: ContextChange }) {
  return (
    <li className="flex flex-col gap-1 rounded-sm border px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <CustodyMark kind={change.actor.type === "human" ? "human" : "unknown"} />
        <span className="font-medium">{describeChange(change)}</span>
        <span className="text-xs text-muted-foreground">r{change.revision}</span>
        <time dateTime={new Date(change.createdAt).toISOString()} className="ml-auto text-xs text-muted-foreground">
          {formatAbsolute(change.createdAt)}
        </time>
      </div>
      <p className="text-xs">{change.title}</p>
      {change.reason && <p className="text-xs text-muted-foreground">Why: {change.reason}</p>}
      <div className="flex flex-wrap items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
        <EvidenceChip evidence={change.evidence} />
        <Confidence value={change.confidence} />
        <span>· {change.status}</span>
        {change.run && (
          <span>
            · {change.run.method === "llm" ? (change.run.model ?? "model") : "heuristic"} run
          </span>
        )}
        {change.evidenceCount > 0 && <span>· {change.evidenceCount} event{change.evidenceCount === 1 ? "" : "s"}</span>}
      </div>
    </li>
  );
}
