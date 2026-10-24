"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon, PlusIcon } from "lucide-react";
import { toast } from "sonner";
import { normalizeError, useTandemApi } from "@/lib/api";
import { ERROR_COPY } from "@/lib/api/errorCopy";
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

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setName("");
      setError(null);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = parseNewFileName(name);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
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
      router.push(`/w/${workspaceId}/files/${id}`);
    } catch (err) {
      setError(ERROR_COPY[normalizeError(err).code].description);
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
              placeholder="proposal.md"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={error ? true : undefined}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
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
