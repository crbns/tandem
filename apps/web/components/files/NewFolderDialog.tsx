"use client";

import { useRef, useState, type FormEvent } from "react";
import { FolderPlusIcon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { normalizeError, useTandemApi } from "@/lib/api";
import { describeError } from "@/lib/api/errorCopy";
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

/** Creates a folder inside `parentId` (null = the workspace root). */
export function NewFolderDialog({
  workspaceId,
  parentId,
  onCreated,
}: {
  workspaceId: string;
  parentId: string | null;
  onCreated?: () => void;
}) {
  const api = useTandemApi();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Bumped whenever the dialog closes, so a late result doesn't reopen errors.
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
    if (!name.trim()) {
      setError("Enter a folder name.");
      return;
    }
    if (name.includes("/")) {
      setError("Folder names can't contain /. Create one folder at a time.");
      return;
    }
    const thisAttempt = ++attempt.current;
    setCreating(true);
    setError(null);
    try {
      const folder = await api.createFolder(workspaceId, { name, parentId });
      toast.success(`Created folder ${folder.name}`);
      onCreated?.();
      if (thisAttempt === attempt.current) onOpenChange(false);
    } catch (err) {
      if (thisAttempt !== attempt.current) return;
      setError(describeError(normalizeError(err), { FOLDER_NOT_FOUND: "This folder was moved or deleted. Go back and try again." }));
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
            <DialogDescription>Created in the folder you&rsquo;re viewing.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="new-folder-name">Name</Label>
            <Input
              id="new-folder-name"
              autoFocus
              placeholder="specs"
              maxLength={255}
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
