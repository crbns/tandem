"use client";

import Link from "next/link";
import { useState } from "react";
import { useParams } from "next/navigation";
import type { AgentNetwork as Network } from "@/lib/api/types";
import { useAgentNetwork } from "@/lib/api/useLive";
import { networkHeadline, propagation } from "@/lib/live";
import { AgentNetwork } from "@/components/live/AgentNetwork";
import { ActivityTimeline } from "@/components/live/ActivityTimeline";
import { MockAgentControls } from "@/components/live/MockAgentControls";
import { KIND_STYLE } from "@/components/live/kinds";
import { ErrorState } from "@/components/common/ErrorState";
import { Skeleton } from "@/components/ui/skeleton";

export default function LivePage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { resource, retry } = useAgentNetwork(workspaceId);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const agents = resource.status === "ready" ? resource.data.agents : [];
  // A revoked assistant drops out of the network; stop filtering by it.
  const selected = agents.some((a) => a.connectionId === connectionId) ? connectionId : null;

  return (
    <div className="mx-auto flex max-w-[88rem] flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold leading-8 tracking-[-0.01em]">Live</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Each assistant works in its own app and reaches this workspace only through Tandem. This page shows each
          tool call as Tandem records it, and which approved context each assistant has received.
        </p>
      </div>

      {/* Side by side only once the network keeps room for its ring beside the timeline. */}
      <div className="grid items-start gap-5 min-[1400px]:grid-cols-[minmax(0,1fr)_25rem]">
        <section aria-labelledby="live-network" className="flex flex-col gap-4 rounded-md border bg-card px-5 py-4">
          {resource.status === "loading" && (
            <>
              <Skeleton className="h-6 w-80" />
              <Skeleton className="h-96" aria-label="Loading assistants" />
            </>
          )}
          {resource.status === "error" && <ErrorState error={resource.error} onRetry={retry} />}
          {resource.status === "ready" && (
            <>
              <Headline network={resource.data} />
              {resource.data.agents.length === 0 ? (
                <EmptyNetwork workspaceId={workspaceId} network={resource.data} />
              ) : (
                <AgentNetwork
                  workspaceId={workspaceId}
                  network={resource.data}
                  selectedId={selected}
                  onSelect={setConnectionId}
                />
              )}
              <Legend />
            </>
          )}
        </section>

        <div className="min-[1400px]:sticky min-[1400px]:top-4 min-[1400px]:flex min-[1400px]:max-h-[calc(100vh-2rem)] min-[1400px]:flex-col">
          <ActivityTimeline
            workspaceId={workspaceId}
            agents={agents}
            connectionId={selected}
            onConnectionChange={setConnectionId}
          />
        </div>
      </div>

      <MockAgentControls agents={agents} />
    </div>
  );
}

function Headline({ network }: { network: Network }) {
  const lagging = network.agents.filter((agent) => propagation(agent).state !== "current");
  return (
    <div className="flex flex-col gap-2">
      <h2 id="live-network" className="text-base font-semibold">
        {networkHeadline(network)}
      </h2>
      {network.contextRevision > 0 && lagging.length > 0 && (
        <ul aria-label="Assistants without the current context" className="flex flex-wrap gap-1.5">
          {lagging.map((agent) => {
            const sync = propagation(agent);
            return (
              <li
                key={agent.connectionId}
                className={
                  sync.state === "behind"
                    ? "rounded-sm border border-warn-rule bg-warn-tint px-2 py-0.5 text-xs text-warn"
                    : "rounded-sm border border-dashed border-unknown px-2 py-0.5 text-xs text-muted-foreground"
                }
              >
                <span className="font-medium">{agent.label}</span>: {sync.label.toLowerCase()}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function EmptyNetwork({ workspaceId, network }: { workspaceId: string; network: Network }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-md border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
      <p>
        {network.contextRevision > 0 ? `Context v${network.contextRevision} is approved. ` : ""}
        Connected assistants will appear here around Tandem.
      </p>
      <Link href={`/w/${workspaceId}/assistants`} className="font-medium text-primary hover:underline">
        Connect an assistant
      </Link>
    </div>
  );
}

const PULSE_KEYS = [
  { kind: "sync", label: "Sync" },
  { kind: "read", label: "Read" },
  { kind: "write", label: "Write or proposal" },
  { kind: "conflict", label: "Conflict" },
  { kind: "approve", label: "Person's decision" },
] as const;

function Legend() {
  return (
    <div className="flex flex-col gap-2 border-t pt-3 text-xs text-muted-foreground">
      <ul aria-label="Edges" className="flex flex-wrap gap-x-5 gap-y-1.5">
        <LegendLine label="Has the current context" className="stroke-archive/45" width={1.5} />
        <LegendLine label="Behind" className="stroke-warn" dash="7 6" />
        <LegendLine label="Never synchronized" className="stroke-unknown" dash="1 6" />
      </ul>
      <ul aria-label="Pulses" className="flex flex-wrap gap-x-5 gap-y-1.5">
        {PULSE_KEYS.map(({ kind, label }) => (
          <li key={kind} className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-[3px] w-4 rounded-full" style={{ background: KIND_STYLE[kind].stroke }} />
            {label}
          </li>
        ))}
      </ul>
      <p className="max-w-3xl">
        Assistants receive updates when they call sync_workspace. Tandem can&apos;t push to native chats. Each call
        is recorded when it finishes, so work in progress isn&apos;t visible, and status comes from the last call:
        it doesn&apos;t say whether a chat is open.
      </p>
    </div>
  );
}

function LegendLine({ label, className, dash, width = 2 }: { label: string; className: string; dash?: string; width?: number }) {
  return (
    <li className="inline-flex items-center gap-1.5">
      <svg aria-hidden width="24" height="6" viewBox="0 0 24 6">
        <line x1="1" y1="3" x2="23" y2="3" className={className} strokeWidth={width} strokeDasharray={dash} strokeLinecap="round" />
      </svg>
      {label}
    </li>
  );
}
