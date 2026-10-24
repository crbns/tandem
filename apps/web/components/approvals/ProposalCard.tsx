"use client";

import Link from "next/link";
import { CheckIcon, Loader2Icon, XIcon } from "lucide-react";
import type { ContextProposal } from "@/lib/api";
import { displayId } from "@/lib/files";
import { FIELD_LABELS, replacesValue } from "@/lib/proposals";
import { formatAbsolute, formatRelative } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { ActorBadge } from "@/components/common/ActorBadge";
import { fileHref } from "@/components/files/FileTable";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type Decision = "approved" | "rejected";

interface ProposalCardProps {
  proposal: ContextProposal;
  /** The approved value it would replace (goal and scope only); "" when unset. */
  current?: string;
  /** Owner/admin: show Approve and Reject. Members get the record only. */
  canDecide: boolean;
  /** The decision in flight for this card, if any. */
  deciding: Decision | null;
  /** Any decision in flight on the page: one at a time, so results stay legible. */
  busy: boolean;
  onDecide: (decision: Decision) => void;
}

/** One pending proposal: what would change, who proposed it and why. */
export function ProposalCard({ proposal, current, canDecide, deciding, busy, onDecide }: ProposalCardProps) {
  const now = useNow();
  const label = FIELD_LABELS[proposal.field];
  const headingId = `proposal-${proposal.id}`;

  return (
    <article aria-labelledby={headingId} className="rounded-md border bg-card px-5 py-4">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="label-caps rounded-sm bg-archive-tint px-1.5 py-0.5 text-archive">{label}</span>
        <span>{replacesValue(proposal.field) ? "change proposed by" : "addition proposed by"}</span>
        <ActorBadge actor={proposal.createdBy} />
        <span title={formatAbsolute(proposal.createdAt)}>{formatRelative(proposal.createdAt, now)}</span>
      </p>

      <h2 id={headingId} className="mt-2 text-base font-semibold leading-6">
        {proposal.proposedValue}
      </h2>

      <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
        {replacesValue(proposal.field) && current !== undefined && (
          <>
            <dt className="label-caps pt-0.5 text-muted-foreground">Replaces</dt>
            <dd className={cn(!current && "text-muted-foreground")}>{current || `No ${label.toLowerCase()} approved yet`}</dd>
          </>
        )}
        <dt className="label-caps pt-0.5 text-muted-foreground">Why</dt>
        <dd className={cn(!proposal.rationale && "text-muted-foreground")}>{proposal.rationale || "No reason given"}</dd>
        {proposal.sourceFileIds.length > 0 && (
          <>
            <dt className="label-caps pt-0.5 text-muted-foreground">Based on</dt>
            <dd className="flex flex-wrap gap-x-3 gap-y-1">
              {proposal.sourceFileIds.map((fileId) => (
                <Link
                  key={fileId}
                  href={fileHref(proposal.workspaceId, fileId)}
                  className="label-caps text-foreground underline underline-offset-2 hover:text-archive"
                >
                  {displayId(fileId)}
                </Link>
              ))}
            </dd>
          </>
        )}
      </dl>

      {canDecide && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => onDecide("approved")} disabled={busy}>
            {deciding === "approved" ? <Loader2Icon className="animate-spin" /> : <CheckIcon />}
            Approve
          </Button>
          <Button size="sm" variant="outline" onClick={() => onDecide("rejected")} disabled={busy}>
            {deciding === "rejected" ? <Loader2Icon className="animate-spin" /> : <XIcon />}
            Reject
          </Button>
        </div>
      )}
    </article>
  );
}

const STATUS_STYLE: Record<ContextProposal["status"], { label: string; className: string }> = {
  pending: { label: "Pending", className: "text-muted-foreground" },
  approved: { label: "Approved", className: "text-archive" },
  rejected: { label: "Rejected", className: "text-muted-foreground" },
  stale: { label: "Stale", className: "text-warn" },
};

/** A decided proposal, one row in the record. */
export function DecidedProposal({ proposal }: { proposal: ContextProposal }) {
  const now = useNow();
  const status = STATUS_STYLE[proposal.status];
  const at = proposal.decidedAt ?? proposal.createdAt;
  return (
    <li className="flex flex-col gap-1 border-b px-4 py-3 text-sm last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={cn("label-caps w-18 shrink-0", status.className)}>{status.label}</span>
        <span className="label-caps text-muted-foreground">{FIELD_LABELS[proposal.field]}</span>
        <span className="min-w-0 flex-1 truncate font-medium">{proposal.proposedValue}</span>
        <span className="text-xs text-muted-foreground" title={formatAbsolute(at)}>
          {formatRelative(at, now)}
        </span>
      </div>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>proposed by</span>
        <ActorBadge actor={proposal.createdBy} />
        {proposal.decidedBy ? (
          <>
            <span>· {proposal.status === "approved" ? "approved" : "rejected"} by</span>
            <ActorBadge actor={proposal.decidedBy} />
          </>
        ) : (
          proposal.status === "stale" && <span>· the field changed before it was approved</span>
        )}
      </p>
    </li>
  );
}
