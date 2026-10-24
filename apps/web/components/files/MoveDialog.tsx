"use client";

import { useEffect, useState, type FormEvent } from "react";
import { FolderIcon, HomeIcon, Loader2Icon } from "lucide-react";
import { normalizeError, useTandemApi } from "@/lib/api";
import type { FolderSummary } from "@/lib/api/types";
import { describeError } from "@/lib/api/errorCopy";
import { moveTargets } from "@/lib/folders";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export interface MoveItem {
  kind: "file" | "folder";
  id: string;
  name: string;
  parentId: string | null;
}

interface MoveDialogProps {
  workspaceId: string;
  item: MoveItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Performs the move with the item's own expected version or revision. */
  onMove: (parentId: string | null) => Promise<unknown>;
  /** After a move, and after a conflict so the list shows the latest state. */
  onChanged?: () => void;
}

/** Folder picker for Move…: the root, then every folder from `listFolderTree`. */
export function MoveDialog({ workspaceId, item, open, onOpenChange, onMove, onChanged }: MoveDialogProps) {
  const api = useTandemApi();
  const [tree, setTree] = useState<FolderSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setTree(null);
    setSelected(undefined);
    setError(null);
    api.listFolderTree(workspaceId).then(
      (folders) => {
        if (!cancelled) setTree(folders);
      },
      (err: unknown) => {
        if (!cancelled) setError(describeError(normalizeError(err)));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, open, workspaceId]);

  const targets = tree ? moveTargets(tree, item) : [];

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || selected === undefined) return;
    setBusy(true);
    setError(null);
    try {
      await onMove(selected);
      onOpenChange(false);
      onChanged?.();
    } catch (err) {
      const normalized = normalizeError(err);
      if (normalized.code === "VERSION_CONFLICT" || normalized.code === "FOLDER_NOT_FOUND") onChanged?.();
      setError(
        describeError(normalized, {
          VERSION_CONFLICT: `“${item.name}” changed since you opened it. Close this, review it and try again.`,
          FOLDER_NOT_FOUND: "That folder was moved or deleted. Pick another destination.",
        }),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Move {item.kind}</DialogTitle>
            <DialogDescription>
              Choose where “{item.name}” should live.
              {item.kind === "file" ? " Moving saves a new version; its history comes along." : " Everything inside comes along."}
            </DialogDescription>
          </DialogHeader>
          <div
            role="radiogroup"
            aria-label="Destination folder"
            className="max-h-72 overflow-y-auto rounded-md border bg-card p-1"
            aria-busy={tree === null && !error ? true : undefined}
          >
            {tree === null && !error && (
              <p className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
                <Loader2Icon className="size-4 animate-spin" /> Loading folders…
              </p>
            )}
            {targets.map((target) => {
              const checked = selected === target.id;
              const Icon = target.id === null ? HomeIcon : FolderIcon;
              return (
                <button
                  key={target.id ?? "root"}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={target.path === "/" ? target.name : target.path}
                  disabled={target.disabled || busy}
                  onClick={() => setSelected(target.id)}
                  style={{ paddingLeft: `${0.5 + target.depth * 1}rem` }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-sm py-1.5 pr-2 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
                    checked && "bg-accent font-semibold",
                  )}
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate">{target.name}</span>
                  {target.reason && (
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {target.reason === "current" ? "Current folder" : "Inside this folder"}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || selected === undefined}>
              {busy && <Loader2Icon className="animate-spin" />}
              {busy ? "Moving…" : "Move here"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
