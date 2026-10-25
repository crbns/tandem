"use client";

import { useCallback, useState } from "react";
import { CheckIcon, CopyIcon, Share2Icon } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { normalizeError, useTandemApi } from "@/lib/api";
import { ERROR_COPY } from "@/lib/api/errorCopy";
import { useResource } from "@/lib/api/useResource";
import { formatInviteCode } from "@/lib/inviteCode";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export function InviteDialog({ workspaceId }: { workspaceId: string }) {
  const api = useTandemApi();
  const load = useCallback(() => api.listWorkspaces(), [api]);
  const { resource } = useResource(load);
  const role = resource.status === "ready" ? resource.data.find((w) => w.id === workspaceId)?.role : null;

  if (role !== "owner" && role !== "admin") return null;
  return (
    <Dialog key={workspaceId}>
      <DialogTrigger asChild><Button variant="outline" size="sm">Invite</Button></DialogTrigger>
      <DialogContent className="grid gap-4">
        <DialogHeader>
          <DialogTitle>Invite a teammate</DialogTitle>
          <DialogDescription>Share the code, the QR code or the link. Anyone who uses it joins as a member. It expires in seven days and works once.</DialogDescription>
        </DialogHeader>
        <InviteForm workspaceId={workspaceId} />
      </DialogContent>
    </Dialog>
  );
}

// DialogContent unmounts this form on close; changing workspace also resets it.
function InviteForm({ workspaceId }: { workspaceId: string }) {
  const api = useTandemApi();
  const [code, setCode] = useState("");
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only rendered after a click, so reading window here can't mismatch hydration.
  const link = code ? `${window.location.origin}/invite/${code}` : "";
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  async function createInvite() {
    setCreating(true);
    setError(null);
    try {
      const { token } = await api.createInvite(workspaceId, "member");
      setCode(token);
      setCopied(null);
    } catch (err) {
      setError(ERROR_COPY[normalizeError(err).code].description);
    } finally {
      setCreating(false);
    }
  }

  async function copy(what: "code" | "link") {
    try {
      await navigator.clipboard.writeText(what === "code" ? code : link);
      setCopied(what);
    } catch {
      setError(`Couldn't copy the ${what}. Select it and copy it manually.`);
    }
  }

  async function share() {
    try {
      await navigator.share({
        title: "Join my Tandem workspace",
        text: `Join my Tandem workspace with code ${code}, or open this link:`,
        url: link,
      });
    } catch (err) {
      // Closing the share sheet rejects with AbortError; that's not a failure.
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError("Couldn't open sharing. Copy the link instead.");
    }
  }

  return (
    <>
      {code ? (
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="workspace-invite-code">Invite code</Label>
            <div className="grid gap-2 sm:flex sm:items-center">
              <output
                id="workspace-invite-code"
                aria-label={`Invite code ${code.split("").join(" ")}`}
                className="flex-1 select-all rounded-md border bg-muted/40 px-3 py-2 text-center font-mono text-3xl font-semibold tracking-[0.3em]"
              >
                {formatInviteCode(code)}
              </output>
              <Button variant="outline" onClick={() => copy("code")}>
                {copied === "code" ? <CheckIcon /> : <CopyIcon />}
                {copied === "code" ? "Copied" : "Copy code"}
              </Button>
            </div>
          </div>
          {/* Dark modules on a white quiet zone stay scannable in dark mode. */}
          <div className="mx-auto rounded-md bg-white p-3">
            <QRCodeSVG value={link} size={176} level="M" bgColor="#ffffff" fgColor="#000000" title="QR code for the invite link" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="workspace-invite-link">Invite link</Label>
            <Input id="workspace-invite-link" readOnly value={link} onFocus={(e) => e.target.select()} />
            <div className="flex gap-2">
              <Button className="flex-1" onClick={() => copy("link")}>
                {copied === "link" ? <CheckIcon /> : <CopyIcon />}
                {copied === "link" ? "Copied" : "Copy link"}
              </Button>
              {canShare && (
                <Button variant="outline" className="flex-1" onClick={share}>
                  <Share2Icon />
                  Share
                </Button>
              )}
            </div>
          </div>
          <Button variant="outline" onClick={createInvite} disabled={creating}>{creating ? "Creating…" : "Create another invite"}</Button>
        </div>
      ) : (
        <Button onClick={createInvite} disabled={creating}>{creating ? "Creating…" : "Create invite"}</Button>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </>
  );
}
