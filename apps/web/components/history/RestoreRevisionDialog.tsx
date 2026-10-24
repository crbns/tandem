"use client";

import { useState } from "react";
import { useTandemApi } from "@/lib/api";
import { normalizeError, type TandemApiError } from "@/lib/api/errors";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter, DialogTrigger } from "@/components/ui/dialog";

export function RestoreRevisionDialog({ fileId, version, expectedVersion, onRestored, onRefresh }: {
  fileId: string;
  version: number;
  expectedVersion: number;
  onRestored: (version: number) => void;
  onRefresh: () => void;
}) {
  const api = useTandemApi();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<TandemApiError | null>(null);

  async function restore() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const restored = await api.restoreRevision(fileId, version, expectedVersion);
      setOpen(false);
      onRestored(restored.version);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!saving) { setOpen(next); setError(null); } }}>
      <DialogTrigger asChild><Button variant="outline" size="sm">Restore v{version}</Button></DialogTrigger>
      <DialogContent>
        <DialogTitle>Restore version {version}?</DialogTitle>
        <DialogDescription>
          This creates version {expectedVersion + 1} with the content of version {version}.
          All previous versions and any unsaved editor draft are kept.
        </DialogDescription>
        {error && <p role="alert" className="text-sm text-destructive">
          {error.code === "VERSION_CONFLICT"
            ? "The file changed since you loaded this page. Refresh history and review the latest version before restoring."
            : "Could not restore this revision. Try again."}
        </p>}
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => setOpen(false)}>Cancel</Button>
          {error?.code === "VERSION_CONFLICT"
            ? <Button onClick={() => { setOpen(false); onRefresh(); }}>Refresh history</Button>
            : <Button disabled={saving} onClick={restore}>{saving ? "Restoring…" : "Restore revision"}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
