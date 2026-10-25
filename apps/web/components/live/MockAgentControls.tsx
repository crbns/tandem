"use client";

import { useState } from "react";
import { toast } from "sonner";
import { normalizeError, useMockControls, type NetworkAgent } from "@/lib/api";
import { ERROR_COPY } from "@/lib/api/errorCopy";
import type { SimulatedCall } from "@/lib/api/mock";
import { Button } from "@/components/ui/button";

const CALLS: ReadonlyArray<{ call: SimulatedCall; label: string }> = [
  { call: "sync", label: "sync_workspace" },
  { call: "read", label: "read_file" },
  { call: "write", label: "update_document" },
  { call: "stale_write", label: "Stale update_document" },
];

/** Mock mode only: make a connected assistant call a tool, to see the page react. */
export function MockAgentControls({ workspaceId, agents }: { workspaceId: string; agents: NetworkAgent[] }) {
  const mock = useMockControls();
  const [picked, setPicked] = useState<string | null>(null);
  if (!mock || agents.length === 0) return null;
  const connectionId = agents.some((a) => a.connectionId === picked) ? picked! : agents[0]!.connectionId;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed bg-card px-4 py-3 text-xs text-muted-foreground">
      <span className="label-caps">Mock data</span>
      <span>Simulate an MCP call from</span>
      <select
        aria-label="Assistant to simulate"
        value={connectionId}
        onChange={(e) => setPicked(e.target.value)}
        className="h-8 max-w-56 truncate rounded-md border border-input bg-card px-2 text-xs text-foreground"
      >
        {agents.map((agent) => (
          <option key={agent.connectionId} value={agent.connectionId}>
            {agent.label}
          </option>
        ))}
      </select>
      {CALLS.map(({ call, label }) => (
        <Button
          key={call}
          variant="outline"
          size="sm"
          className="font-mono text-xs"
          onClick={() => {
            try {
              mock.__simulateAgentCall(connectionId, call);
            } catch (err) {
              toast.error(ERROR_COPY[normalizeError(err).code].title);
            }
          }}
        >
          {label}
        </Button>
      ))}
      <span className="ml-2">or</span>
      <Button
        variant="outline"
        size="sm"
        className="border-dashed text-xs"
        onClick={() => {
          try {
            mock.__simulateIntelActivity(workspaceId);
          } catch (err) {
            toast.error(ERROR_COPY[normalizeError(err).code].title);
          }
        }}
      >
        Simulated Claude Code event
      </Button>
    </div>
  );
}
