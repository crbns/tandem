"use client";

import { useRef, useState, type FormEvent } from "react";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { normalizeError, useTandemApi, type Folder } from "@/lib/api";
import { ERROR_COPY, RENAME_FOLDER_ERROR_COPY } from "@/lib/api/errorCopy";
import type { ApiErrorCode } from "@/lib/api/errors";
import { parseNewFolderName } from "@/lib/files";
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

// After these the list on screen is out of date, so the page refetches.
const REFETCH_ON: ReadonlySet<ApiErrorCode> = new Set(["VERSION_CONFLICT", "FOLDER_NOT_FOUND"]);

interface RenameFolderDialogProps {
  /** The folder to rename, kept current by the page so a retry uses the latest revision. */
  folder: Folder | null;
  onOpenChange: (open: boolean) => void;
  /** Refetch the register: after a rename, or when the folder changed underneath. */
  onRefresh: () => void;
}

export function RenameFolderDialog({ folder, onOpenChange, onRefresh }: RenameFolderDialogProps) {
  return (
    <Dialog open={folder !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {folder && (
          // Keyed by folder so each opening starts from its current name.
          <RenameForm key={folder.id} folder={folder} onClose={() => onOpenChange(false)} onRefresh={onRefresh} />
        )}
      </DialogContent>
    </Dialog>
  );
}

interface RenameFormProps {
  folder: Folder;
  onClose: () => void;
  onRefresh: () => void;
}

function RenameForm({ folder, onClose, onRefresh }: RenameFormProps) {
  const api = useTandemApi();
  const [name, setName] = useState(folder.name);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  // Bumped on close, so a rename that finishes afterwards doesn't report into a dismissed dialog.
  const attempt = useRef(0);
  const unchanged = name.trim() === folder.name;

  function close() {
    attempt.current += 1;
    onClose();
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (unchanged) return;
    const parsed = parseNewFolderName(name);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const thisAttempt = ++attempt.current;
    setRenaming(true);
    setError(null);
    try {
      await api.renameFolder(folder.id, { name: parsed.name, expectedRevision: folder.revision });
      toast.success(`Renamed ${folder.name} to ${parsed.name}`);
      onRefresh();
      if (thisAttempt === attempt.current) onClose();
    } catch (err) {
      if (thisAttempt !== attempt.current) return;
      const { code, details } = normalizeError(err);
      if (REFETCH_ON.has(code)) onRefresh();
      setError(
        code === "NAME_EXISTS" && details.existingName
          ? `Another folder here is already named ${details.existingName}. Names ignore case and surrounding spaces.`
          : (RENAME_FOLDER_ERROR_COPY[code] ?? ERROR_COPY[code].description),
      );
      setRenaming(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Rename {folder.name}</DialogTitle>
        <DialogDescription>
          Files inside keep their versions and links. Teammates&rsquo; assistants see the new name on their next sync.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        <Label htmlFor="rename-folder-name">Name</Label>
        <Input
          id="rename-folder-name"
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "rename-folder-error" : undefined}
        />
        {error && (
          <p id="rename-folder-error" role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={close}>
          Cancel
        </Button>
        <Button type="submit" disabled={renaming || unchanged}>
          {renaming && <Loader2Icon className="animate-spin" />}
          Rename
        </Button>
      </DialogFooter>
    </form>
  );
}
