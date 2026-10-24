"use client";

import { useState, type FormEvent } from "react";
import { CheckIcon, CopyIcon, Loader2Icon, PlusIcon } from "lucide-react";
import { normalizeError, useTandemApi, type AgentClient } from "@/lib/api";
import { ERROR_COPY } from "@/lib/api/errorCopy";
import { claudeCodeCommand, mcpEndpoint } from "@/lib/assistants";
import { clientName } from "@/lib/actors";
import { MCP_URL } from "@/lib/config";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const CLIENT_OPTIONS: ReadonlyArray<{ value: AgentClient; label: string }> = [
  { value: "claude", label: "Claude" },
  { value: "chatgpt", label: "ChatGPT" },
  { value: "gemini", label: "Gemini" },
  { value: "other", label: "Other" },
];

interface ConnectAssistantDialogProps {
  workspaceId: string;
  /** A connection was created; refresh the list. */
  onCreated: () => void;
}

export function ConnectAssistantDialog({ workspaceId, onCreated }: ConnectAssistantDialogProps) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <PlusIcon />
          Connect an assistant
        </Button>
      </DialogTrigger>
      {/* DialogContent unmounts on close, so the token never survives a reopen. */}
      <DialogContent className="grid gap-4 sm:max-w-xl">
        <ConnectForm workspaceId={workspaceId} onCreated={onCreated} onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function ConnectForm({ workspaceId, onCreated, onDone }: ConnectAssistantDialogProps & { onDone: () => void }) {
  const api = useTandemApi();
  const [client, setClient] = useState<AgentClient>("claude");
  const [displayName, setDisplayName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const created = await api.createAgentConnection(workspaceId, {
        client,
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      });
      setToken(created.token);
      onCreated();
    } catch (err) {
      setError(ERROR_COPY[normalizeError(err).code].description);
    } finally {
      setCreating(false);
    }
  }

  if (token) return <TokenReveal client={client} token={token} onDone={onDone} />;

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Connect an assistant</DialogTitle>
        <DialogDescription>
          Your assistant gets its own token for this workspace. It reads and saves files as you, and every save is
          marked Agent with your name.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        <span aria-hidden className="text-sm font-medium leading-none">
          Assistant
        </span>
        <SegmentedControl label="Assistant" value={client} options={CLIENT_OPTIONS} onChange={setClient} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="assistant-display-name">
          Name <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id="assistant-display-name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={`e.g. ${clientName(client)} on my laptop`}
          maxLength={80}
          autoComplete="off"
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="submit" disabled={creating}>
          {creating && <Loader2Icon className="animate-spin" />}
          {creating ? "Creating…" : "Create token"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function TokenReveal({ client, token, onDone }: { client: AgentClient; token: string; onDone: () => void }) {
  const endpoint = mcpEndpoint(MCP_URL);
  const command = claudeCodeCommand(MCP_URL, token);
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Copy your token now</DialogTitle>
        <DialogDescription>
          Tandem only keeps a fingerprint of it, so this is the only time it&apos;s shown. If you lose it, revoke this
          connection and create a new one.
        </DialogDescription>
      </DialogHeader>

      <CopyField id="assistant-token" label="Token" value={token} />

      {(client === "claude" || client === "other") && (
        <div className="grid gap-2">
          <span className="text-sm font-medium leading-none">Claude Code setup</span>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed">
            {command}
          </pre>
          <CopyButton value={command} label="Copy command" />
        </div>
      )}

      <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[7rem_minmax(0,1fr)]">
        <dt className="label-caps pt-0.5 text-muted-foreground">Server URL</dt>
        <dd className="break-all font-mono text-xs leading-5">{endpoint}</dd>
        <dt className="label-caps pt-0.5 text-muted-foreground">Header</dt>
        <dd className="break-all font-mono text-xs leading-5">Authorization: Bearer &lt;token&gt;</dd>
      </dl>

      {!MCP_URL && (
        <Alert variant="warning">
          <AlertTitle>Server address not configured</AlertTitle>
          <AlertDescription>
            This build has no NEXT_PUBLIC_MCP_URL, so replace &lt;MCP_URL&gt; with your Tandem MCP server&apos;s
            address.
          </AlertDescription>
        </Alert>
      )}

      <DialogFooter>
        <Button onClick={onDone}>I&apos;ve saved the token</Button>
      </DialogFooter>
    </div>
  );
}

function CopyField({ id, label, value }: { id: string; label: string; value: string }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input id={id} readOnly value={value} onFocus={(e) => e.target.select()} className="font-mono text-xs" />
        <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
      </div>
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  }
  return (
    <Button type="button" variant="outline" onClick={copy} className="w-fit">
      {state === "copied" ? <CheckIcon /> : <CopyIcon />}
      {state === "copied" ? "Copied" : state === "failed" ? "Select and copy manually" : label}
    </Button>
  );
}
