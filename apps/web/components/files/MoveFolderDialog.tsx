"use client";

import { useRef, useState, type FormEvent } from "react";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { normalizeError, useTandemApi, type Folder } from "@/lib/api";
import { ERROR_COPY, MOVE_FOLDER_ERROR_COPY } from "@/lib/api/errorCopy";
import type { ApiErrorCode } from "@/lib/api/errors";
import { folderSubtree } from "@/lib/files";
import { FolderPicker, TOP_LEVEL, toParentId } from "@/components/files/FolderPicker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// After these the tree on screen is out of date, so the page refetches.
const REFETCH_ON: ReadonlySet<ApiErrorCode> = new Set(["VERSION_CONFLICT", "FOLDER_NOT_FOUND", "FOLDER_CYCLE"]);

interface MoveFolderDialogProps {
  /** The folder to move, kept current by the page so a retry uses the latest revision. */
  folder: Folder | null;
  folders: Folder[];
  onOpenChange: (open: boolean) => void;
  /** Refetch the register: after a move, or when the tree changed underneath. */
  onRefresh: () => void;
}

export function MoveFolderDialog({ folder, folders, onOpenChange, onRefresh }: MoveFolderDialogProps) {
  return (
    <Dialog open={folder !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {folder && (
          // Keyed by folder so each opening starts with nothing picked.
          <MoveForm key={folder.id} folder={folder} folders={folders} onClose={() => onOpenChange(false)} onRefresh={onRefresh} />
        )}
      </DialogContent>
    </Dialog>
  );
}

interface MoveFormProps {
  folder: Folder;
  folders: Folder[];
  onClose: () => void;
  onRefresh: () => void;
}

function MoveForm({ folder, folders, onClose, onRefresh }: MoveFormProps) {
  const api = useTandemApi();
  const [destination, setDestination] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const attempt = useRef(0);
  const current = folder.parentId ?? TOP_LEVEL;
  // A folder can't land inside itself; the backend rejects it too (FOLDER_CYCLE).
  const unavailable = folderSubtree(folders, folder.id);
  const destinationName = (value: string) =>
    value === TOP_LEVEL ? "the top level" : (folders.find((f) => f.id === value)?.name ?? "that folder");

  function close() {
    attempt.current += 1;
    onClose();
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (destination === null || destination === current || unavailable.has(destination)) return;
    const thisAttempt = ++attempt.current;
    setMoving(true);
    setError(null);
    try {
      await api.moveFolder(folder.id, { parentId: toParentId(destination), expectedRevision: folder.revision });
      toast.success(`Moved ${folder.name} to ${destinationName(destination)}`);
      onRefresh();
      if (thisAttempt === attempt.current) onClose();
    } catch (err) {
      if (thisAttempt !== attempt.current) return;
      const { code } = normalizeError(err);
      if (REFETCH_ON.has(code)) onRefresh();
      setError(MOVE_FOLDER_ERROR_COPY[code] ?? ERROR_COPY[code].description);
      setMoving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Move {folder.name}</DialogTitle>
        <DialogDescription>
          Everything inside moves with it, and no file gets a new version. A folder can&rsquo;t move into itself or one of
          its subfolders.
        </DialogDescription>
      </DialogHeader>
      <FolderPicker
        name="move-folder-destination"
        folders={folders}
        current={current}
        value={destination}
        onChange={setDestination}
        unavailable={unavailable}
        self={folder.id}
        disabled={moving}
        error={error}
        errorId="move-folder-error"
      />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={close}>
          Cancel
        </Button>
        <Button type="submit" disabled={moving || destination === null || destination === current}>
          {moving && <Loader2Icon className="animate-spin" />}
          Move
        </Button>
      </DialogFooter>
    </form>
  );
}
