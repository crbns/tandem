"use client";

import { useId, useState, type FormEvent } from "react";
import { normalizeError, useTandemApi } from "@/lib/api";
import type { FolderSummary } from "@/lib/api/types";
import { describeError, FOLDER_ERROR_COPY } from "@/lib/api/errorCopy";
import { describeCounts, subtreeCounts } from "@/lib/folders";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MoveDialog } from "./MoveDialog";

/** Rename, Move… and Delete for one folder row. Delete says how much it removes first. */
export function FolderActions({ folder, onChanged }: { folder: FolderSummary; onChanged?: () => void }) {
  const api = useTandemApi();
  const inputId = useId();
  const [action, setAction] = useState<"rename" | "delete" | null>(null);
  const [moving, setMoving] = useState(false);
  const [name, setName] = useState(folder.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What a delete removes; null while counting or when counting failed.
  const [counts, setCounts] = useState<{ folders: number; files: number } | null>(null);

  function open(next: "rename" | "delete") {
    setName(folder.name);
    setError(null);
    setCounts(null);
    setAction(next);
    if (next === "delete") {
      Promise.all([api.listFolderTree(folder.workspaceId), api.listFiles(folder.workspaceId)]).then(
        ([tree, files]) => setCounts(subtreeCounts(folder.id, tree, files)),
        () => setCounts(null),
      );
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (action === "rename") await api.renameFolder(folder.id, name, folder.revision);
      else await api.deleteFolder(folder.id, folder.revision);
      setAction(null);
      onChanged?.();
    } catch (err) {
      const normalized = normalizeError(err);
      if (normalized.code === "VERSION_CONFLICT" || normalized.code === "FOLDER_NOT_FOUND") onChanged?.();
      setError(describeError(normalized, FOLDER_ERROR_COPY));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="flex gap-2"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <Button variant="outline" size="sm" onClick={() => open("rename")} aria-label={`Rename folder ${folder.name}`}>
        Rename
      </Button>
      <Button variant="outline" size="sm" onClick={() => setMoving(true)} aria-label={`Move folder ${folder.name}`}>
        Move…
      </Button>
      <Button variant="outline" size="sm" onClick={() => open("delete")} aria-label={`Delete folder ${folder.name}`}>
        Delete
      </Button>
      <MoveDialog
        workspaceId={folder.workspaceId}
        item={{ kind: "folder", id: folder.id, name: folder.name, parentId: folder.parentId }}
        open={moving}
        onOpenChange={setMoving}
        onMove={(parentId) => api.moveFolder(folder.id, parentId, folder.revision)}
        onChanged={onChanged}
      />
      <Dialog
        open={action !== null}
        onOpenChange={(next) => {
          if (!next && !busy) setAction(null);
        }}
      >
        <DialogContent>
          <form className="grid gap-4" onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>{action === "rename" ? "Rename folder" : "Delete folder?"}</DialogTitle>
              <DialogDescription>
                {action === "rename"
                  ? "Choose a name no other file or folder here uses."
                  : counts
                    ? `Remove “${folder.name}” and everything in it: ${describeCounts(counts)}? Revision history is kept.`
                    : `Remove “${folder.name}” and everything in it? Revision history is kept.`}
              </DialogDescription>
            </DialogHeader>
            {action === "rename" && (
              <div className="grid gap-2">
                <Label htmlFor={inputId}>Name</Label>
                <Input
                  id={inputId}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoFocus
                  maxLength={255}
                  disabled={busy}
                />
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setAction(null)}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant={action === "delete" ? "destructive" : "default"}
                disabled={busy || (action === "rename" && !name.trim())}
              >
                {busy ? "Saving…" : action === "rename" ? "Rename" : "Delete folder"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
