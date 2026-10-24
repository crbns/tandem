"use client";

import { useRef, useState, type FormEvent } from "react";
import { FolderPlusIcon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { normalizeError, useTandemApi } from "@/lib/api";
import { CREATE_FOLDER_ERROR_COPY, ERROR_COPY } from "@/lib/api/errorCopy";
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
  DialogTrigger,
} from "@/components/ui/dialog";

interface NewFolderDialogProps {
  workspaceId: string;
  /** Where the folder goes: the folder being viewed, or null for the top level. */
  parentId: string | null;
  /** Shown in the description so it's clear where the folder lands. */
  parentName?: string;
  onCreated?: (folderId: string) => void;
}

export function NewFolderDialog({ workspaceId, parentId, parentName, onCreated }: NewFolderDialogProps) {
  const api = useTandemApi();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Bumped whenever the dialog closes, so a create that finishes afterwards
  // doesn't report into a dialog the user already dismissed.
  const attempt = useRef(0);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      attempt.current += 1;
      setName("");
      setError(null);
      setCreating(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = parseNewFolderName(name);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const thisAttempt = ++attempt.current;
    setCreating(true);
    setError(null);
    try {
      const { id } = await api.createFolder(workspaceId, { name: parsed.name, parentId });
      toast.success(`Created folder ${parsed.name}`);
      onCreated?.(id);
      if (thisAttempt === attempt.current) onOpenChange(false);
    } catch (err) {
      if (thisAttempt !== attempt.current) return;
      const { code } = normalizeError(err);
      setError(CREATE_FOLDER_ERROR_COPY[code] ?? ERROR_COPY[code].description);
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <FolderPlusIcon />
          New folder
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={onSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>
              {parentName ? <>Creates a folder inside {parentName}.</> : <>Creates a folder at the top level.</>}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="new-folder-name">Name</Label>
            <Input
              id="new-folder-name"
              autoFocus
              placeholder="Research"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "new-folder-error" : undefined}
            />
            {error && (
              <p id="new-folder-error" role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={creating}>
              {creating && <Loader2Icon className="animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
