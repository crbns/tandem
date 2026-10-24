"use client";

import type { Revision } from "@/lib/api/types";
import { formatAbsolute, formatRelative } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { ActorBadge } from "@/components/common/ActorBadge";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface RevisionListProps {
  /** Newest first. */
  revisions: Revision[];
  headVersion: number;
  selected: number;
  onSelect: (version: number) => void;
}

export function RevisionList({ revisions, headVersion, selected, onSelect }: RevisionListProps) {
  const now = useNow();
  return (
    <ol className="flex flex-col gap-1" aria-label="Revisions">
      {revisions.map((rev) => (
        <li key={rev.version}>
          <button
            type="button"
            onClick={() => onSelect(rev.version)}
            aria-current={rev.version === selected ? "true" : undefined}
            className={cn(
              "flex w-full flex-col gap-1.5 rounded-md border px-3 py-2 text-left text-sm transition-colors",
              rev.version === selected ? "border-primary/40 bg-accent" : "border-transparent hover:bg-accent/60",
            )}
          >
            <span className="flex items-center gap-2">
              <span className="font-semibold tabular-nums">v{rev.version}</span>
              {rev.version === headVersion && <Badge variant="secondary">Current</Badge>}
              <span className="ml-auto text-xs text-muted-foreground">{formatRelative(rev.createdAt, now)}</span>
            </span>
            <ActorBadge actor={rev} />
            <span className="text-xs text-muted-foreground">{formatAbsolute(rev.createdAt)}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}
