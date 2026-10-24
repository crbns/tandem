"use client";

import { useCallback, useState } from "react";
import { normalizeError, useTandemApi } from "@/lib/api";
import { ERROR_COPY } from "@/lib/api/errorCopy";
import { useResource } from "@/lib/api/useResource";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export function InviteDialog({ workspaceId }: { workspaceId: string }) {
  const api = useTandemApi();
  const load = useCallback(() => api.listWorkspaces(), [api]);
  const { resource } = useResource(load);
  const [link, setLink] = useState("");
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const role = resource.status === "ready" ? resource.data.find((w) => w.id === workspaceId)?.role : null;

  async function createInvite() {
    setCreating(true);
    setError(null);
    try {
      const { token } = await api.createInvite(workspaceId, "member");
      setLink(`${window.location.origin}/invite/${token}`);
      setCopied(false);
    } catch (err) {
      setError(ERROR_COPY[normalizeError(err).code].description);
    } finally {
      setCreating(false);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setError("Couldn't copy the link. Select it and copy it manually.");
    }
  }

  if (role !== "owner" && role !== "admin") return null;
  return (
    <Dialog>
      <DialogTrigger asChild><Button variant="outline" size="sm">Invite</Button></DialogTrigger>
      <DialogContent className="grid gap-4">
        <DialogHeader>
          <DialogTitle>Invite a teammate</DialogTitle>
          <DialogDescription>Anyone with this link can join as a member. It expires in seven days and can be used once.</DialogDescription>
        </DialogHeader>
        {link ? (
          <div className="grid gap-2">
            <Label htmlFor="workspace-invite-link">Invite link</Label>
            <Input id="workspace-invite-link" readOnly value={link} onFocus={(e) => e.target.select()} />
            <Button onClick={copyLink}>{copied ? "Copied" : "Copy link"}</Button>
          </div>
        ) : (
          <Button onClick={createInvite} disabled={creating}>{creating ? "Creating…" : "Create invite link"}</Button>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}
