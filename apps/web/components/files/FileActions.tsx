"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { normalizeError, useTandemApi } from "@/lib/api";
import type { FileSummary } from "@/lib/api/types";
import { ERROR_COPY } from "@/lib/api/errorCopy";
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

export function FileActions({
  file,
  onChanged,
  redirectAfterDelete = false,
}: {
  file: FileSummary;
  onChanged?: () => void;
  redirectAfterDelete?: boolean;
}) {
  const api = useTandemApi();
  const router = useRouter();
  const inputId = useId();
  const [action, setAction] = useState<"rename" | "delete" | null>(null);
  const [name, setName] = useState(file.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function open(next: "rename" | "delete") {
    setName(file.name);
    setError(null);
    setAction(next);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (action === "rename")
        await api.renameFile(file.id, name, file.version);
      else await api.deleteFile(file.id, file.version);
      setAction(null);
      onChanged?.();
      if (action === "delete" && redirectAfterDelete)
        router.push(`/w/${file.workspaceId}`);
    } catch (err) {
      const { code } = normalizeError(err);
      if (code === "VERSION_CONFLICT") onChanged?.();
      setError(
        code === "VERSION_CONFLICT"
          ? "The file changed. Review it and try again."
          : ERROR_COPY[code].description,
      );
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
      <Button
        variant="outline"
        size="sm"
        onClick={() => open("rename")}
        aria-label={`Rename ${file.name}`}
      >
        Rename
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => open("delete")}
        aria-label={`Delete ${file.name}`}
      >
        Delete
      </Button>
      <Dialog
        open={action !== null}
        onOpenChange={(next) => {
          if (!next && !busy) setAction(null);
        }}
      >
        <DialogContent>
          <form className="grid gap-4" onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>
                {action === "rename" ? "Rename file" : "Delete file?"}
              </DialogTitle>
              <DialogDescription>
                {action === "rename"
                  ? "Choose a unique name in this folder."
                  : `Remove “${file.name}” from the workspace? Its revision history will be kept.`}
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
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setAction(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant={action === "delete" ? "destructive" : "default"}
                disabled={busy || (action === "rename" && !name.trim())}
              >
                {busy
                  ? "Saving…"
                  : action === "rename"
                    ? "Rename"
                    : "Delete file"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
