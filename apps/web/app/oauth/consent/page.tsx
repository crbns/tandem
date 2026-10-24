"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircleIcon, Loader2Icon } from "lucide-react";
import {
  normalizeError,
  useTandemApi,
  type AgentClient,
  type ConsentRequest,
  type TandemApiError,
} from "@/lib/api";
import { ERROR_COPY } from "@/lib/api/errorCopy";
import { clientName } from "@/lib/actors";
import { useSession } from "@/lib/auth/useSession";
import { ErrorState } from "@/components/common/ErrorState";
import { FullPageSpinner } from "@/components/common/FullPageSpinner";
import { TandemMark } from "@/components/common/TandemMark";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";

const CLIENT_OPTIONS: ReadonlyArray<{ value: AgentClient; label: string }> = [
  { value: "claude", label: "Claude" },
  { value: "chatgpt", label: "ChatGPT" },
  { value: "gemini", label: "Gemini" },
  { value: "other", label: "Other" },
];

type Load =
  | { status: "loading" }
  | { status: "error"; error: TandemApiError }
  | { status: "ready"; request: ConsentRequest | null };

/**
 * Where an assistant's OAuth sign-in lands (`?request=<id>` from the Convex
 * MCP server). The person picks which workspace and assistant this is, then
 * approves or denies; the browser then goes back to the assistant.
 */
function Consent() {
  const params = useSearchParams();
  const requestId = params.get("request") ?? "";
  const { status } = useSession();
  const router = useRouter();
  const api = useTandemApi();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  // Never show the approval UI inside a frame (clickjacking); the
  // frame-ancestors header already blocks this where the host sends it.
  const [framed, setFramed] = useState(false);
  useEffect(() => setFramed(window.top !== window.self), []);

  const fetchRequest = useCallback(() => {
    setLoad({ status: "loading" });
    api.getConsentRequest(requestId).then(
      (request) => setLoad({ status: "ready", request }),
      (err: unknown) => setLoad({ status: "error", error: normalizeError(err) }),
    );
  }, [api, requestId]);

  useEffect(() => {
    if (status === "unauthenticated") {
      // Come back to this exact URL, request id included.
      const here = `${window.location.pathname}${window.location.search}`;
      router.replace(`/sign-in?next=${encodeURIComponent(here)}`);
      return;
    }
    if (status === "authenticated" && requestId) fetchRequest();
  }, [status, requestId, router, fetchRequest]);

  if (framed) return <Shell><Gone title="Open this page directly" body="For your safety, Tandem won't show connection requests inside another site." /></Shell>;
  if (!requestId) return <Shell><Gone title="Nothing to approve" body="Start connecting from your assistant; it will send you back here." /></Shell>;
  if (status !== "authenticated" || load.status === "loading") return <FullPageSpinner />;
  if (load.status === "error")
    return <Shell><ErrorState error={load.error} onRetry={fetchRequest} /></Shell>;
  if (!load.request || load.request.status !== "pending")
    return <Shell><Gone title={ERROR_COPY.REQUEST_EXPIRED.title} body={ERROR_COPY.REQUEST_EXPIRED.description} /></Shell>;
  return (
    <Shell>
      <ConsentForm requestId={requestId} request={load.request} />
    </Shell>
  );
}

function ConsentForm({ requestId, request }: { requestId: string; request: ConsentRequest }) {
  const api = useTandemApi();
  const router = useRouter();
  const [workspaceId, setWorkspaceId] = useState(request.workspaces.length === 1 ? request.workspaces[0]!.id : "");
  const [client, setClient] = useState<AgentClient>(request.suggestedClient);
  const [pending, setPending] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const name = request.clientName ?? "An assistant";

  async function decide(approve: boolean) {
    setPending(approve ? "allow" : "deny");
    setError(null);
    try {
      const { redirectUrl } = await api.decideConsent(
        requestId,
        approve ? { approve: true, workspaceId, client } : { approve: false },
      );
      // Back to the assistant, which finishes signing in. Only mock mode
      // returns a path in this app; keep its in-memory state.
      if (redirectUrl.startsWith("/")) router.push(redirectUrl);
      else window.location.assign(redirectUrl);
    } catch (err) {
      setError(ERROR_COPY[normalizeError(err).code].description);
      setPending(null);
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="text-xl">Connect an assistant to Tandem?</CardTitle>
        <CardDescription>
          <span className="font-medium text-foreground">{name}</span>{" "}
          <span className="label-caps">unverified</span> wants to work in one of your workspaces
          {request.redirectHost && (
            <>
              . Access goes to <span className="font-mono text-foreground">{request.redirectHost}</span>
            </>
          )}
          . Only continue if you just started this from your assistant.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        {request.workspaces.length === 0 ? (
          <Alert variant="warning">
            <AlertTitle>You&apos;re not in a workspace yet</AlertTitle>
            <AlertDescription>Create or join a workspace first, then connect again from your assistant.</AlertDescription>
          </Alert>
        ) : (
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-medium leading-none">Workspace</legend>
            <div role="radiogroup" aria-label="Workspace" className="grid gap-1.5">
              {request.workspaces.map((w) => (
                <label
                  key={w.id}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm",
                    workspaceId === w.id && "border-foreground bg-muted/50",
                  )}
                >
                  <input
                    type="radio"
                    name="workspace"
                    value={w.id}
                    checked={workspaceId === w.id}
                    onChange={() => setWorkspaceId(w.id)}
                  />
                  <span className="min-w-0 flex-1 truncate font-medium">{w.name}</span>
                  <span className="label-caps text-muted-foreground">{w.role}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <div className="grid gap-2">
          <span aria-hidden className="text-sm font-medium leading-none">
            Assistant
          </span>
          <SegmentedControl label="Assistant" value={client} options={CLIENT_OPTIONS} onChange={setClient} />
          <p className="text-xs text-muted-foreground">
            Its saves show as yours, marked &ldquo;via {clientName(client)}&rdquo;.
          </p>
        </div>

        <div className="grid gap-1.5 text-sm">
          <span className="font-medium">It will be able to</span>
          <ul className="grid list-disc gap-1 pl-5 text-muted-foreground">
            {request.scopes.map((scope) => (
              <li key={scope.name}>{scope.description}</li>
            ))}
            <li>Never approve changes to the goal, scope, decisions or ownership: a person does that here.</li>
          </ul>
          <p className="text-xs text-muted-foreground">
            You can disconnect it at any time on the workspace&apos;s Assistants page.
          </p>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => decide(false)} disabled={pending !== null}>
            {pending === "deny" && <Loader2Icon className="animate-spin" />}
            Deny
          </Button>
          <Button onClick={() => decide(true)} disabled={pending !== null || !workspaceId}>
            {pending === "allow" && <Loader2Icon className="animate-spin" />}
            Allow
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Gone({ title, body }: { title: string; body: string }) {
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="text-xl">{title}</CardTitle>
        <CardDescription>{body}</CardDescription>
      </CardHeader>
    </Card>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-background px-4 py-12">
      <div className="flex flex-col items-center gap-3 text-center">
        <TandemMark className="size-10" />
        <p className="text-2xl font-bold tracking-[-0.01em]">Tandem</p>
      </div>
      {children}
    </main>
  );
}

export default function ConsentPage() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <Consent />
    </Suspense>
  );
}
