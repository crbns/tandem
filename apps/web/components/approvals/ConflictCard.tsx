"use client";

import { useId, useState, type ReactNode } from "react";
import { AlertTriangleIcon, CheckIcon, Loader2Icon, SplitIcon, UndoIcon, XIcon } from "lucide-react";
import type { ConflictItem, ContextProposal } from "@/lib/api";
import { CONFLICT_ACTIONS, conflictMethodLabel, FIELD_LABELS, type ConflictAction } from "@/lib/proposals";
import { formatAbsolute, formatRelative } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { ActorBadge } from "@/components/common/ActorBadge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const MAX_NOTE = 2000;

const TARGET_LABELS: Record<ConflictItem["targetType"], string> = {
  decision: "decision",
  constraint: "constraint",
  goal: "goal",
  scope: "scope",
  proposal: "pending proposal",
};

interface ConflictCardProps {
  proposal: ContextProposal;
  /** Owner/admin: show the resolution actions. Members get the record only. */
  canDecide: boolean;
  /** The action in flight for this card, if any. */
  deciding: ConflictAction | null;
  /** Any decision in flight on the page: one at a time. */
  busy: boolean;
  onDecide: (action: ConflictAction, note: string) => void;
}

/**
 * A pending proposal that collides with the approved context (or another
 * proposal): the current value beside the proposed one, why they conflict,
 * and how to settle it. Nothing changes until a person picks an action.
 */
export function ConflictCard({ proposal, canDecide, deciding, busy, onDecide }: ConflictCardProps) {
  const now = useNow();
  const [note, setNote] = useState("");
  const noteId = useId();
  const conflict = proposal.conflict!;
  const checking = conflict.status === "checking";
  const items = conflict.items;
  const headingId = `conflict-${proposal.id}`;
  const label = FIELD_LABELS[proposal.field];
  const competingOnly = items.length > 0 && items.every((item) => item.targetType === "proposal");

  return (
    <article aria-labelledby={headingId} aria-busy={checking} className="rounded-md border border-warn-rule bg-card px-5 py-4">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="label-caps inline-flex items-center gap-1 rounded-sm bg-warn-tint px-1.5 py-0.5 text-warn">
          {checking ? <Loader2Icon className="size-3 animate-spin" aria-hidden /> : <AlertTriangleIcon className="size-3" aria-hidden />}
          {checking ? "Checking" : conflict.status === "uncertain" ? "Possible conflict" : "Conflict"}
        </span>
        <span className="label-caps rounded-sm bg-archive-tint px-1.5 py-0.5 text-archive">{label}</span>
        <span title={formatAbsolute(proposal.createdAt)}>proposed {formatRelative(proposal.createdAt, now)}</span>
      </p>

      <h2 id={headingId} className="mt-2 text-base font-semibold leading-6">
        {checking
          ? `Checking this ${label.toLowerCase()} against the approved context…`
          : competingOnly
            ? `Competes with another pending ${label.toLowerCase()}`
            : `${conflict.status === "uncertain" ? "May conflict" : "Conflicts"} with the approved ${TARGET_LABELS[items[0]?.targetType ?? "decision"]}`}
      </h2>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <section aria-label="Current (approved)" className="flex min-w-0 flex-col gap-2 rounded-md border bg-background px-4 py-3">
          <h3 className="label-caps text-muted-foreground">{competingOnly ? "Other proposal (pending)" : "Current (approved)"}</h3>
          {items.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" aria-hidden />
              Checking for conflicts…
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {items.map((item) => (
                <li key={`${item.targetType}-${item.targetId}`} className="flex min-w-0 flex-col gap-1">
                  <p className="text-sm font-medium break-words">{item.targetText}</p>
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span>{item.targetType === "proposal" ? "proposed by" : "set by"}</span>
                    <ActorBadge actor={item.targetBy} />
                    <span title={formatAbsolute(item.targetAt)}>{formatRelative(item.targetAt, now)}</span>
                    <span>· context v{item.contextVersion}</span>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Proposed" className="flex min-w-0 flex-col gap-2 rounded-md border border-warn-rule bg-warn-tint/40 px-4 py-3">
          <h3 className="label-caps text-warn">Proposed</h3>
          <p className="text-sm font-medium break-words">{proposal.proposedValue}</p>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>by</span>
            <ActorBadge actor={proposal.createdBy} />
          </p>
          <p className={cn("text-sm", !proposal.rationale && "text-muted-foreground")}>
            <span className="label-caps mr-2 text-muted-foreground">Why</span>
            {proposal.rationale || "No reason given"}
          </p>
        </section>
      </div>

      {(items.length > 0 || conflict.reason) && (
        <ul aria-label="Why this was flagged" className="mt-3 flex flex-col gap-2 text-sm">
          {items.map((item) => (
            <li key={`${item.targetType}-${item.targetId}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className={cn("label-caps", item.uncertain ? "text-warn" : "text-archive")}>
                {conflictMethodLabel(conflict, item)}
              </span>
              {item.confidence !== undefined && (
                <span className="text-xs text-muted-foreground">{Math.round(item.confidence * 100)}% confidence</span>
              )}
              <span className="min-w-0 basis-full sm:basis-auto sm:flex-1">{item.explanation}</span>
            </li>
          ))}
          {conflict.reason && <li className="text-xs text-muted-foreground">{conflict.reason}</li>}
        </ul>
      )}

      {canDecide && (
        <div className="mt-4 flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={noteId} className="label-caps text-muted-foreground">
              Note (optional)
            </label>
            <textarea
              id={noteId}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={MAX_NOTE}
              rows={2}
              placeholder="Why you settled it this way. Assistants see this on their next sync."
              disabled={busy}
              className="flex min-h-16 w-full min-w-0 resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Resolve conflict">
            <ActionButton action="accept" icon={<CheckIcon />} deciding={deciding} busy={busy} onClick={() => onDecide("accept", note)} />
            <ActionButton action="keep_current" icon={<UndoIcon />} variant="outline" deciding={deciding} busy={busy} onClick={() => onDecide("keep_current", note)} />
            <ActionButton action="reject" icon={<XIcon />} variant="outline" deciding={deciding} busy={busy} onClick={() => onDecide("reject", note)} />
            <ActionButton
              action="keep_both"
              icon={<SplitIcon />}
              variant="ghost"
              className="sm:ml-auto"
              deciding={deciding}
              busy={busy}
              onClick={() => onDecide("keep_both", note)}
            />
          </div>
        </div>
      )}
    </article>
  );
}

function ActionButton({
  action,
  icon,
  variant,
  className,
  deciding,
  busy,
  onClick,
}: {
  action: ConflictAction;
  icon: ReactNode;
  variant?: "outline" | "ghost";
  className?: string;
  deciding: ConflictAction | null;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <Button size="sm" variant={variant} className={className} onClick={onClick} disabled={busy}>
      {deciding === action ? <Loader2Icon className="animate-spin" /> : icon}
      {CONFLICT_ACTIONS[action].label}
    </Button>
  );
}
