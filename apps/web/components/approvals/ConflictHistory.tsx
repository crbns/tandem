"use client";

import type { ContextProposal } from "@/lib/api";
import { FIELD_LABELS, RESOLUTION_LABELS } from "@/lib/proposals";
import { formatAbsolute, formatRelative } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { ActorBadge } from "@/components/common/ActorBadge";
import { cn } from "@/lib/utils";

/**
 * Settled conflicts, newest first: both values, the outcome, who decided and
 * their note. History only; the context itself shows what's in effect.
 */
export function ConflictHistory({ resolved }: { resolved: ContextProposal[] }) {
  if (resolved.length === 0) return null;
  return (
    <section aria-labelledby="conflict-history-heading" className="flex flex-col gap-2">
      <h2 id="conflict-history-heading" className="text-base font-bold leading-6">
        Conflict history
      </h2>
      <ul className="rounded-md border bg-card">
        {resolved.map((proposal) => (
          <ConflictHistoryItem key={proposal.id} proposal={proposal} />
        ))}
      </ul>
    </section>
  );
}

function ConflictHistoryItem({ proposal }: { proposal: ContextProposal }) {
  const now = useNow();
  const at = proposal.decidedAt ?? proposal.createdAt;
  const approved = proposal.status === "approved";
  const outcome = proposal.resolution
    ? RESOLUTION_LABELS[proposal.resolution]
    : proposal.status === "stale"
      ? "Stale"
      : approved
        ? "Accepted"
        : "Rejected";
  const current = proposal.conflict?.items ?? [];
  // Which side is in effect now: the proposal when approved, the current value otherwise.
  const proposedWon = approved;
  const keptBoth = proposal.resolution === "kept_both";

  return (
    <li className="flex flex-col gap-2 border-b px-4 py-3 text-sm last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={cn("label-caps", approved ? "text-archive" : "text-muted-foreground")}>{outcome}</span>
        <span className="label-caps text-muted-foreground">{FIELD_LABELS[proposal.field]}</span>
        <span className="ml-auto text-xs text-muted-foreground" title={formatAbsolute(at)}>
          {formatRelative(at, now)}
        </span>
      </div>
      <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="label-caps text-muted-foreground">
            Current {!proposedWon || keptBoth ? "(kept)" : "(replaced)"}
          </dt>
          {current.length === 0 ? (
            <dd className="text-muted-foreground">Nothing recorded</dd>
          ) : (
            current.map((item) => (
              <dd key={`${item.targetType}-${item.targetId}`} className={cn("break-words", proposedWon && !keptBoth && "text-muted-foreground line-through")}>
                {item.targetText}
              </dd>
            ))
          )}
        </div>
        <div className="min-w-0">
          <dt className="label-caps text-muted-foreground">Proposed {proposedWon ? "(in effect)" : "(not applied)"}</dt>
          <dd className={cn("break-words", !proposedWon && "text-muted-foreground")}>{proposal.proposedValue}</dd>
          <dd className="mt-1 text-xs text-muted-foreground">
            <ActorBadge actor={proposal.createdBy} />
          </dd>
        </div>
      </dl>
      {proposal.decidedBy && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>resolved by</span>
          <ActorBadge actor={proposal.decidedBy} />
        </p>
      )}
      {proposal.decisionNote && (
        <blockquote className="border-l-2 border-archive-tint pl-3 text-sm text-muted-foreground italic break-words">
          {proposal.decisionNote}
        </blockquote>
      )}
    </li>
  );
}
