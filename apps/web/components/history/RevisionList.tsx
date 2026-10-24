"use client";

import type { Revision } from "@/lib/api/types";
import { formatAbsolute, formatRelative } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { ActorBadge } from "@/components/common/ActorBadge";
import { CustodyMark } from "@/components/common/CustodyMark";
import { cn } from "@/lib/utils";

interface RevisionListProps {
  /** Newest first. */
  revisions: Revision[];
  headVersion: number;
  selected: number;
  onSelect: (version: number) => void;
}

/** The chain of custody: one entry per version on a single rule, newest first. */
export function RevisionList({ revisions, headVersion, selected, onSelect }: RevisionListProps) {
  const now = useNow();
  return (
    <ol className="border-l-2 border-border" aria-label="Versions, newest first">
      {revisions.map((rev) => {
        const isSelected = rev.version === selected;
        return (
          <li key={rev.version} className="relative pb-1 pl-4">
            <CustodyMark kind={rev.actorType} size="lg" className="absolute -left-[7px] top-3.5" />
            <button
              type="button"
              onClick={() => onSelect(rev.version)}
              aria-current={isSelected ? "true" : undefined}
              className={cn(
                "flex w-full flex-col items-start gap-1 rounded-md px-3 py-2.5 text-left transition-colors",
                isSelected ? "bg-archive-tint" : "hover:bg-accent/70",
              )}
            >
              <span className="flex w-full items-center gap-2">
                <span className="label-caps">v{rev.version}</span>
                {rev.version === headVersion && <span className="label-caps text-archive">Current</span>}
                <span className="ml-auto text-xs text-muted-foreground" title={formatAbsolute(rev.createdAt)}>
                  {formatRelative(rev.createdAt, now)}
                </span>
              </span>
              <ActorBadge actor={rev} />
            </button>
          </li>
        );
      })}
    </ol>
  );
}
