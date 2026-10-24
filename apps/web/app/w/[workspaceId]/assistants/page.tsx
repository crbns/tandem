"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { CheckIcon, CopyIcon, Loader2Icon, RotateCwIcon } from "lucide-react";
import { toast } from "sonner";
import { normalizeError, useTandemApi, type AgentConnection } from "@/lib/api";
import { ERROR_COPY } from "@/lib/api/errorCopy";
import { useResource } from "@/lib/api/useResource";
import { useWorkspaceRefresh, useWorkspaceRole } from "@/lib/api/useWorkspace";
import { clientName } from "@/lib/actors";
import { sortConnections } from "@/lib/assistants";
import { formatAbsolute, formatRelative } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { ConnectAssistantDialog } from "@/components/assistants/ConnectAssistantDialog";
import { CustodyMark } from "@/components/common/CustodyMark";
import { ErrorState } from "@/components/common/ErrorState";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export default function AssistantsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const api = useTandemApi();
  const role = useWorkspaceRole(workspaceId);
  const seesEveryone = role === "owner" || role === "admin";

  const load = useCallback(() => api.listAgentConnections(workspaceId), [api, workspaceId]);
  const { resource, refreshing, reload } = useResource(load);
  // Connect/revoke and every MCP write record a workspace event; read-only MCP
  // calls only bump the times, which show on focus or Refresh.
  useWorkspaceRefresh(workspaceId, reload);
  const [revoking, setRevoking] = useState<AgentConnection | null>(null);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <h1 className="text-2xl font-bold leading-8 tracking-[-0.01em]">Assistants</h1>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={reload} disabled={refreshing} aria-label="Refresh connections">
            <RotateCwIcon className={cn(refreshing && "animate-spin")} />
            Refresh
          </Button>
          <ConnectAssistantDialog workspaceId={workspaceId} onCreated={reload} />
        </div>
      </div>
      <p className="-mt-2 max-w-2xl text-sm text-muted-foreground">
        Connect the assistant you already use (Claude, ChatGPT or Gemini) to this workspace through Tandem&apos;s MCP
        server. It works in its own app; Tandem only sees what it reads and saves here. Times show when Tandem last
        heard from it, not whether it&apos;s running.
        {seesEveryone && " As an owner or admin you see everyone's connections."}
      </p>

      <ServerUrl />

      {resource.status === "loading" && (
        <div className="flex flex-col gap-2" aria-label="Loading connections">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      )}

      {resource.status === "error" && <ErrorState error={resource.error} onRetry={reload} retrying={refreshing} />}

      {resource.status === "ready" && resource.data.length === 0 && (
        <div className="rounded-md border border-dashed bg-card px-6 py-10 text-center text-sm text-muted-foreground">
          No assistants are connected yet. Add the server URL to your assistant, or create an API key.
        </div>
      )}

      {resource.status === "ready" && resource.data.length > 0 && (
        <ul aria-label="Assistant connections" className="rounded-md border bg-card">
          {sortConnections(resource.data).map((connection) => (
            <ConnectionRow
              key={connection.id}
              connection={connection}
              showPerson={seesEveryone}
              onRevoke={() => setRevoking(connection)}
            />
          ))}
        </ul>
      )}

      <RevokeDialog
        connection={revoking}
        onClose={() => setRevoking(null)}
        onRevoked={() => {
          setRevoking(null);
          reload();
        }}
      />
    </div>
  );
}

function connectionTitle(connection: AgentConnection): string {
  return connection.displayName ?? clientName(connection.client);
}

function authLabel(connection: AgentConnection): string {
  if (connection.authKind === "api_key") return "API key";
  if (connection.authKind === "oauth")
    return connection.oauthClientName ? `Signed in as “${connection.oauthClientName}” (unverified)` : "Signed in";
  return "Old token, no longer works";
}

/** The URL to paste into an assistant, with the two ways to connect. */
function ServerUrl() {
  const api = useTandemApi();
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api.getMcpServerUrl().then(
      (value) => !cancelled && setUrl(value),
      () => !cancelled && setUrl(null),
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section aria-label="Server URL" className="grid gap-3 rounded-md border bg-card px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="label-caps text-muted-foreground">Server URL</span>
        <code className="min-w-0 flex-1 break-all font-mono text-xs">{url ?? "…"}</code>
        <Button variant="outline" size="sm" onClick={copy} disabled={!url}>
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <ul className="grid list-disc gap-1 pl-5 text-muted-foreground">
        <li>
          <span className="text-foreground">claude.ai</span>: Settings → Connectors → Add custom connector, paste the
          URL, then sign in to Tandem and pick this workspace when it asks.
        </li>
        <li>
          <span className="text-foreground">Claude Code and scripts</span>: create an API key and send it as{" "}
          <code className="font-mono text-xs">Authorization: Bearer</code>.
        </li>
      </ul>
    </section>
  );
}

function ConnectionRow({
  connection,
  showPerson,
  onRevoke,
}: {
  connection: AgentConnection;
  showPerson: boolean;
  onRevoke: () => void;
}) {
  const now = useNow();
  const revoked = connection.revokedAt !== undefined;
  const when = (at: number | undefined) =>
    at === undefined ? (
      <span className="text-muted-foreground">never</span>
    ) : (
      <span title={formatAbsolute(at)}>{formatRelative(at, now)}</span>
    );

  return (
    <li className={cn("flex flex-wrap items-center gap-x-6 gap-y-2 border-b px-4 py-3 text-sm last:border-b-0", revoked && "bg-muted/40")}>
      <div className="flex min-w-0 flex-1 basis-56 items-center gap-2">
        <CustodyMark kind={revoked ? "unknown" : "agent"} />
        <div className="min-w-0">
          <div className={cn("truncate font-semibold", revoked && "text-muted-foreground line-through")}>
            {connectionTitle(connection)}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {clientName(connection.client)}
            {` · ${authLabel(connection)}`}
            {showPerson && ` · ${connection.userName ?? "A teammate"}`}
            {" · connected "}
            <span title={formatAbsolute(connection.createdAt)}>{formatRelative(connection.createdAt, now)}</span>
          </div>
        </div>
      </div>
      <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-xs">
        <dt className="label-caps text-muted-foreground">Last MCP action</dt>
        <dd>{when(connection.lastMcpActionAt)}</dd>
        <dt className="label-caps text-muted-foreground">Last sync</dt>
        <dd>{when(connection.lastSyncAt)}</dd>
      </dl>
      <div className="flex w-24 justify-end">
        {revoked ? (
          <span className="label-caps text-muted-foreground" title={formatAbsolute(connection.revokedAt!)}>
            Revoked
          </span>
        ) : (
          <Button variant="ghost" size="sm" onClick={onRevoke} aria-label={`Revoke ${connectionTitle(connection)}`}>
            Revoke
          </Button>
        )}
      </div>
    </li>
  );
}

function RevokeDialog({
  connection,
  onClose,
  onRevoked,
}: {
  connection: AgentConnection | null;
  onClose: () => void;
  onRevoked: () => void;
}) {
  const api = useTandemApi();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    if (pending) return;
    setError(null);
    onClose();
  }

  async function revoke() {
    if (!connection) return;
    setPending(true);
    setError(null);
    try {
      await api.revokeAgentConnection(connection.id);
      toast.success(`${connectionTitle(connection)} can no longer reach this workspace.`);
      onRevoked();
    } catch (err) {
      setError(ERROR_COPY[normalizeError(err).code].description);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={connection !== null}
      onOpenChange={(open) => !open && close()}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke {connection ? connectionTitle(connection) : "this assistant"}?</DialogTitle>
          <DialogDescription>
            Its sign-in or API key stops working right away, so the assistant can&apos;t read or save files here any
            more. Everything it already saved stays in history. To reconnect, connect it again.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={pending}>
            Keep connected
          </Button>
          <Button variant="destructive" onClick={revoke} disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            Revoke
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
