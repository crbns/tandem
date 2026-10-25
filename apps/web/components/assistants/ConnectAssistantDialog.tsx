"use client";

import { useState, type FormEvent } from "react";
import { Loader2Icon, PlusIcon } from "lucide-react";
import { normalizeError, useTandemApi, type AgentClient } from "@/lib/api";
import { ERROR_COPY } from "@/lib/api/errorCopy";
import { claudeCodeCommand } from "@/lib/assistants";
import { clientName } from "@/lib/actors";
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
import { ClaudeCodeHooksSetup } from "./ClaudeCodeHooksSetup";
import { CopyButton } from "./CopyButton";

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
          Create API key
        </Button>
      </DialogTrigger>
      {/* DialogContent unmounts on close, so the key never survives a reopen. */}
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
  const [created, setCreated] = useState<{ token: string; mcpUrl: string } | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const result = await api.createAgentConnection(workspaceId, {
        client,
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      });
      setCreated({ token: result.token, mcpUrl: result.mcpUrl });
      onCreated();
    } catch (err) {
      setError(ERROR_COPY[normalizeError(err).code].description);
    } finally {
      setCreating(false);
    }
  }

  if (created) return <TokenReveal client={client} token={created.token} mcpUrl={created.mcpUrl} onDone={onDone} />;

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Create an API key</DialogTitle>
        <DialogDescription>
          For assistants you set up with a header, like Claude Code. The key works in this workspace only; the
          assistant reads and saves files as you, and every save is marked Agent with your name. For claude.ai, add
          the server URL as a custom connector instead and sign in when it asks.
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
          {creating ? "Creating…" : "Create key"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function TokenReveal({
  client,
  token,
  mcpUrl,
  onDone,
}: {
  client: AgentClient;
  token: string;
  mcpUrl: string;
  onDone: () => void;
}) {
  const command = claudeCodeCommand(mcpUrl, token);
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Copy your API key now</DialogTitle>
        <DialogDescription>
          Tandem only keeps a fingerprint of it, so this is the only time it&apos;s shown. If you lose it, revoke this
          connection and create a new one.
        </DialogDescription>
      </DialogHeader>

      <CopyField id="assistant-token" label="API key" value={token} />

      {(client === "claude" || client === "other") && (
        <div className="grid gap-2">
          <span className="text-sm font-medium leading-none">Claude Code setup</span>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed">
            {command}
          </pre>
          <CopyButton value={command} label="Copy command" />
        </div>
      )}

      {(client === "claude" || client === "other") && <ClaudeCodeHooksSetup mcpUrl={mcpUrl} token={token} />}

      <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[7rem_minmax(0,1fr)]">
        <dt className="label-caps pt-0.5 text-muted-foreground">Server URL</dt>
        <dd className="break-all font-mono text-xs leading-5">{mcpUrl}</dd>
        <dt className="label-caps pt-0.5 text-muted-foreground">Header</dt>
        <dd className="break-all font-mono text-xs leading-5">Authorization: Bearer &lt;API key&gt;</dd>
      </dl>

      <DialogFooter>
        <Button onClick={onDone}>I&apos;ve saved the key</Button>
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
