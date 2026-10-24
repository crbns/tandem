"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon, PlusIcon } from "lucide-react";
import { toast } from "sonner";
import { normalizeError, useTandemApi } from "@/lib/api";
import { CREATE_ERROR_COPY, ERROR_COPY } from "@/lib/api/errorCopy";
import { parseNewFileName } from "@/lib/files";
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

export function NewFileDialog({ workspaceId }: { workspaceId: string }) {
  const api = useTandemApi();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Bumped whenever the dialog closes, so a create that finishes afterwards
  // doesn't yank the user to the new file.
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
    const parsed = parseNewFileName(name);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const thisAttempt = ++attempt.current;
    setCreating(true);
    setError(null);
    try {
      const title = parsed.name.replace(/\.[^.]+$/, "");
      const content = parsed.mimeType === "text/markdown" ? `# ${title}\n` : "";
      const { id } = await api.createFile(workspaceId, {
        name: parsed.name,
        mimeType: parsed.mimeType,
        content,
      });
      toast.success(`Created ${parsed.name} (version 1)`);
      if (thisAttempt === attempt.current) router.push(`/w/${workspaceId}/files/${id}`);
    } catch (err) {
      if (thisAttempt !== attempt.current) return;
      const { code } = normalizeError(err);
      setError(CREATE_ERROR_COPY[code] ?? ERROR_COPY[code].description);
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <PlusIcon />
          New file
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={onSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New file</DialogTitle>
            <DialogDescription>
              Markdown by default. Use <code>.txt</code> for plain text.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="new-file-name">Name</Label>
            <Input
              id="new-file-name"
              autoFocus
              placeholder="meeting-notes.md"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "new-file-error" : undefined}
            />
            {error && (
              <p id="new-file-error" role="alert" className="text-sm text-destructive">
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
