"use client";

import { useRef, useState, type FormEvent } from "react";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { normalizeError, useTandemApi, type FileSummary, type Folder } from "@/lib/api";
import { ERROR_COPY, MOVE_ERROR_COPY } from "@/lib/api/errorCopy";
import type { ApiErrorCode } from "@/lib/api/errors";
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

// After these the list on screen is out of date, so the page refetches.
const REFETCH_ON: ReadonlySet<ApiErrorCode> = new Set(["VERSION_CONFLICT", "FOLDER_NOT_FOUND", "FILE_NOT_FOUND"]);

interface MoveFileDialogProps {
  /** The file to move, kept current by the page so a retry uses the latest version. */
  file: FileSummary | null;
  folders: Folder[];
  onOpenChange: (open: boolean) => void;
  /** Refetch the register: after a move, or when the file or folders changed underneath. */
  onRefresh: () => void;
}

export function MoveFileDialog({ file, folders, onOpenChange, onRefresh }: MoveFileDialogProps) {
  const open = file !== null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {file && (
          // Keyed by file so each opening starts with nothing picked.
          <MoveForm key={file.id} file={file} folders={folders} onClose={() => onOpenChange(false)} onRefresh={onRefresh} />
        )}
      </DialogContent>
    </Dialog>
  );
}

interface MoveFormProps {
  file: FileSummary;
  folders: Folder[];
  onClose: () => void;
  onRefresh: () => void;
}

function MoveForm({ file, folders, onClose, onRefresh }: MoveFormProps) {
  const api = useTandemApi();
  const [destination, setDestination] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const attempt = useRef(0);
  const current = file.parentId ?? TOP_LEVEL;
  const destinationName = (value: string) =>
    value === TOP_LEVEL ? "the top level" : (folders.find((f) => f.id === value)?.name ?? "that folder");

  function close() {
    attempt.current += 1;
    onClose();
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (destination === null || destination === current) return;
    const thisAttempt = ++attempt.current;
    setMoving(true);
    setError(null);
    try {
      await api.moveFile(file.id, {
        parentId: toParentId(destination),
        expectedVersion: file.version,
      });
      toast.success(`Moved ${file.name} to ${destinationName(destination)}`);
      onRefresh();
      if (thisAttempt === attempt.current) onClose();
    } catch (err) {
      if (thisAttempt !== attempt.current) return;
      const { code } = normalizeError(err);
      if (REFETCH_ON.has(code)) onRefresh();
      setError(MOVE_ERROR_COPY[code] ?? ERROR_COPY[code].description);
      setMoving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Move {file.name}</DialogTitle>
        <DialogDescription>
          Moving keeps every version and doesn&rsquo;t create a new one. Teammates&rsquo; assistants see the new location on
          their next sync.
        </DialogDescription>
      </DialogHeader>
      <FolderPicker
        name="move-file-destination"
        folders={folders}
        current={current}
        value={destination}
        onChange={setDestination}
        disabled={moving}
        error={error}
        errorId="move-file-error"
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
