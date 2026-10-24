"use client";

import Link from "next/link";
import {
  CheckIcon,
  CircleAlertIcon,
  CircleDotIcon,
  HistoryIcon,
  Loader2Icon,
  SaveIcon,
  Undo2Icon,
} from "lucide-react";
import type { Actor } from "@/lib/api/types";
import type { SavePhase } from "@/lib/editor/saveMachine";
import { formatAbsolute, formatRelative } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { ActorBadge } from "@/components/common/ActorBadge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const STATE_LABEL: Record<SavePhase["kind"], { label: string; className: string; Icon: typeof CheckIcon }> = {
  clean: { label: "Saved", className: "text-emerald-700", Icon: CheckIcon },
  dirty: { label: "Unsaved changes", className: "text-amber-700", Icon: CircleDotIcon },
  saving: { label: "Saving…", className: "text-muted-foreground", Icon: Loader2Icon },
  conflict: { label: "Conflict", className: "text-destructive", Icon: CircleAlertIcon },
  error: { label: "Not saved", className: "text-destructive", Icon: CircleAlertIcon },
};

interface SaveBarProps {
  version: number;
  phase: SavePhase["kind"];
  lastEditedBy: Actor;
  lastEditedAt: number;
  canSave: boolean;
  onSave: () => void;
  /** Shown when there are unsaved edits that can be thrown away. */
  onDiscard?: () => void;
  historyHref: string;
  readOnly?: boolean;
}

export function SaveBar({
  version,
  phase,
  lastEditedBy,
  lastEditedAt,
  canSave,
  onSave,
  onDiscard,
  historyHref,
  readOnly,
}: SaveBarProps) {
  const now = useNow();
  const state = STATE_LABEL[phase];

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-sidebar px-3 py-2 text-sm">
      {/* While there are unsaved edits, the number is the version they're based on, not the head. */}
      <span className="font-medium tabular-nums">{phase === "clean" ? `Version ${version}` : `Editing from v${version}`}</span>
      <span className={cn("inline-flex items-center gap-1.5", state.className)} aria-live="polite">
        <state.Icon className={cn("size-4", phase === "saving" && "animate-spin")} aria-hidden />
        {state.label}
      </span>
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        Last edited by <ActorBadge actor={lastEditedBy} />
        <span title={formatAbsolute(lastEditedAt)}>{formatRelative(lastEditedAt, now)}</span>
      </span>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="ghost" size="sm" asChild>
          <Link href={historyHref}>
            <HistoryIcon />
            History
          </Link>
        </Button>
        {!readOnly && onDiscard && (
          <Button variant="ghost" size="sm" onClick={onDiscard}>
            <Undo2Icon />
            Discard changes
          </Button>
        )}
        {!readOnly && (
          <Button size="sm" onClick={onSave} disabled={!canSave} title="Save (Ctrl/Cmd+S)">
            {phase === "saving" ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
            Save
          </Button>
        )}
      </div>
    </div>
  );
}
