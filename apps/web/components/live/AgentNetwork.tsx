"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { CheckIcon, CircleDashedIcon, ClockIcon } from "lucide-react";
import type { AgentNetwork as Network, NetworkAgent, TimelineItem } from "@/lib/api/types";
import { useActivityArrivals } from "@/lib/api/useLive";
import { clientName } from "@/lib/actors";
import { agentStatus, KIND_META, propagation, ringPositions, STATUS_LABEL, type Flow } from "@/lib/live";
import { formatAbsolute, formatRelative } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { CustodyMark } from "@/components/common/CustodyMark";
import { TandemMark } from "@/components/common/TandemMark";
import { KIND_STYLE } from "./kinds";
import { cn } from "@/lib/utils";

/** Assistants placed on the ring; the rest are listed underneath. */
const RING_MAX = 8;
const CARD_W = 176;
const CENTER_W = CARD_W + 8;
/** Room for an assistant either side of Tandem with an edge between; narrower, the nodes stack. */
const RING_MIN_WIDTH = 2 * CARD_W + CENTER_W + 2 * 48;
const CARD_H = 112;
/** Travel time of a pulse (matches animate-live-travel), then when the far node lights up. */
const TRAVEL_MS = 950;
const ARRIVE_MS = 780;
const STAGGER_MS = 160;
const MAX_PULSES = 16;

interface Pulse {
  key: string;
  connectionId: string | null;
  kind: TimelineItem["kind"];
  flow: Flow;
  delay: number;
}

/**
 * Tandem in the middle, each assistant on a ring around it. An edge's line
 * says whether that assistant has received the current project context;
 * pulses play only for calls that arrive while the page is open.
 */
export function AgentNetwork({
  workspaceId,
  network,
  selectedId,
  onSelect,
}: {
  workspaceId: string;
  network: Network;
  selectedId: string | null;
  onSelect: (connectionId: string | null) => void;
}) {
  const pulses = usePulses(workspaceId);
  const [width, setWidth] = useState<number | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const measure = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    if (!node) return;
    observer.current = new ResizeObserver(([entry]) => {
      setWidth(Math.round(entry!.contentRect.width));
    });
    observer.current.observe(node);
  }, []);

  const ringAgents = network.agents.slice(0, RING_MAX);
  // Placement is by id, not recency, so a node never jumps when it acts.
  const placed = [...ringAgents].sort((a, b) => a.connectionId.localeCompare(b.connectionId));
  const overflow = network.agents.slice(RING_MAX);
  const ring = width !== null && width >= RING_MIN_WIDTH && placed.length > 0;
  // Two assistants sit in one row beside Tandem; more need the full ellipse.
  const box = width === null ? null : { width, height: placed.length <= 2 ? CARD_H + 64 : Math.round(Math.min(500, Math.max(380, width * 0.56))) };

  const centerPulses = pulses.filter((p) => p.flow === "out" || p.flow === "human");

  return (
    <div ref={measure} className="w-full">
      {ring && box ? (
        <Ring
          box={box}
          agents={placed}
          network={network}
          pulses={pulses}
          centerPulses={centerPulses}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <CenterNode network={network} pulses={centerPulses} className="w-full" />
          {placed.length > 0 && (
            <ul aria-label="Connected assistants" className="grid gap-2 sm:grid-cols-2">
              {placed.map((agent) => (
                <li key={agent.connectionId}>
                  <AgentNode
                    agent={agent}
                    contextRevision={network.contextRevision}
                    pulses={pulses.filter((p) => p.connectionId === agent.connectionId)}
                    selected={selectedId === agent.connectionId}
                    onSelect={onSelect}
                    className="w-full"
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {overflow.length > 0 && (
        <ul aria-label="More assistants" className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {overflow.map((agent) => (
            <li key={agent.connectionId}>
              <AgentNode
                agent={agent}
                contextRevision={network.contextRevision}
                pulses={[]}
                selected={selectedId === agent.connectionId}
                onSelect={onSelect}
                className="w-full"
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Ring({
  box,
  agents,
  network,
  pulses,
  centerPulses,
  selectedId,
  onSelect,
}: {
  box: { width: number; height: number };
  agents: NetworkAgent[];
  network: Network;
  pulses: Pulse[];
  centerPulses: Pulse[];
  selectedId: string | null;
  onSelect: (connectionId: string | null) => void;
}) {
  const { width, height } = box;
  const cx = width / 2;
  const cy = height / 2;
  const rx = Math.max(CARD_W, width / 2 - CARD_W / 2 - 4);
  const ry = Math.max(CARD_H, height / 2 - CARD_H / 2 - 4);
  // One or two assistants sit in a row beside Tandem; more start at the top.
  const start = agents.length <= 2 ? Math.PI : -Math.PI / 2;
  const points = ringPositions(agents.length, rx, ry, start).map((p) => ({ x: cx + p.x, y: cy + p.y }));

  return (
    <div className="relative" style={{ height }}>
      <svg aria-hidden width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="absolute inset-0 overflow-visible">
        {agents.map((agent, i) => {
          const p = points[i]!;
          const state = propagation(agent).state;
          return (
            <g key={agent.connectionId}>
              <line
                x1={cx}
                y1={cy}
                x2={p.x}
                y2={p.y}
                strokeWidth={state === "current" ? 1.5 : 2}
                strokeLinecap="round"
                strokeDasharray={state === "behind" ? "7 6" : state === "never" ? "1 6" : undefined}
                className={cn(
                  "transition-[stroke] duration-500",
                  state === "current" && "stroke-archive/45",
                  state === "behind" && "stroke-warn",
                  state === "never" && "stroke-unknown",
                )}
              />
              {pulses
                .filter((pulse) => pulse.connectionId === agent.connectionId)
                .map((pulse) => (
                  <EdgePulse key={pulse.key} pulse={pulse} from={{ x: cx, y: cy }} to={p} />
                ))}
            </g>
          );
        })}
      </svg>
      <CenterNode
        network={network}
        pulses={centerPulses}
        className="absolute -translate-x-1/2 -translate-y-1/2"
        style={{ left: cx, top: cy, width: CENTER_W }}
      />
      <ul aria-label="Connected assistants">
        {agents.map((agent, i) => (
          <li
            key={agent.connectionId}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: points[i]!.x, top: points[i]!.y, width: CARD_W }}
          >
            <AgentNode
              agent={agent}
              contextRevision={network.contextRevision}
              pulses={pulses.filter((p) => p.connectionId === agent.connectionId)}
              selected={selectedId === agent.connectionId}
              onSelect={onSelect}
              className="w-full"
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One call's pulse on its edge: a dash travelling the way the call went, or a flash for a failure. */
function EdgePulse({ pulse, from, to }: { pulse: Pulse; from: { x: number; y: number }; to: { x: number; y: number } }) {
  const stroke = KIND_STYLE[pulse.kind].stroke;
  const style: CSSProperties = { animationDelay: `${pulse.delay}ms`, animationFillMode: "both" };
  if (pulse.flow === "conflict" || pulse.flow === "error") {
    return (
      <line
        x1={from.x}
        y1={from.y}
        x2={to.x}
        y2={to.y}
        stroke={stroke}
        strokeWidth={3}
        strokeLinecap="round"
        className="animate-live-edge-flash"
        style={style}
      />
    );
  }
  const [a, b] = pulse.flow === "in" ? [from, to] : [to, from];
  return (
    <>
      <line
        x1={a.x}
        y1={a.y}
        x2={b.x}
        y2={b.y}
        pathLength={100}
        stroke={stroke}
        strokeOpacity={0.25}
        strokeWidth={9}
        strokeLinecap="round"
        strokeDasharray="18 100"
        className="animate-live-travel"
        style={style}
      />
      <line
        x1={a.x}
        y1={a.y}
        x2={b.x}
        y2={b.y}
        pathLength={100}
        stroke={stroke}
        strokeWidth={3}
        strokeLinecap="round"
        strokeDasharray="18 100"
        className="animate-live-travel"
        style={style}
      />
    </>
  );
}

/** The receiving node's ring, timed to when the pulse reaches it. */
function Rings({ pulses, arrivalDelay }: { pulses: Pulse[]; arrivalDelay: (pulse: Pulse) => number }) {
  return pulses.map((pulse) => (
    <span
      key={pulse.key}
      aria-hidden
      className="pointer-events-none absolute inset-0 rounded-md animate-live-ring"
      style={
        {
          "--flash": `color-mix(in srgb, ${KIND_STYLE[pulse.kind].stroke} 45%, transparent)`,
          animationDelay: `${arrivalDelay(pulse)}ms`,
          animationFillMode: "both",
        } as CSSProperties
      }
    />
  ));
}

function CenterNode({
  network,
  pulses,
  className,
  style,
}: {
  network: Network;
  pulses: Pulse[];
  className?: string;
  style?: CSSProperties;
}) {
  const now = useNow();
  const { contextRevision, contextUpdatedAt } = network;
  // Derived during render: the version ticks only when it changes, not on load.
  const [shown, setShown] = useState(contextRevision);
  const [bumped, setBumped] = useState(false);
  if (shown !== contextRevision) {
    setShown(contextRevision);
    setBumped(true);
  }
  return (
    <div
      className={cn("relative z-10 rounded-md border border-archive/40 bg-card px-4 py-3 text-center", className)}
      style={style}
    >
      <Rings pulses={pulses} arrivalDelay={(p) => p.delay + (p.flow === "human" ? 0 : ARRIVE_MS)} />
      <div className="flex items-center justify-center gap-2">
        <TandemMark className="size-5" />
        <span className="text-sm font-semibold">Tandem</span>
      </div>
      {contextRevision > 0 ? (
        <>
          <div className="mt-1.5 flex items-baseline justify-center gap-1.5" aria-live="polite">
            <span className="text-xs text-muted-foreground">Context</span>
            <span key={contextRevision} className={cn("text-2xl font-bold leading-7 text-archive", bumped && "animate-custody-in")}>
              v{contextRevision}
            </span>
          </div>
          {contextUpdatedAt !== null && (
            <div className="text-xs text-muted-foreground" title={formatAbsolute(contextUpdatedAt)}>
              updated {formatRelative(contextUpdatedAt, now)}
            </div>
          )}
        </>
      ) : (
        <div className="mt-1.5 text-xs text-muted-foreground">No project context yet</div>
      )}
    </div>
  );
}

function AgentNode({
  agent,
  contextRevision,
  pulses,
  selected,
  onSelect,
  className,
}: {
  agent: NetworkAgent;
  contextRevision: number;
  pulses: Pulse[];
  selected: boolean;
  onSelect: (connectionId: string | null) => void;
  className?: string;
}) {
  const now = useNow();
  const status = agentStatus(agent, now);
  const sync = propagation(agent);
  const lastHeard = Math.max(agent.lastMcpActionAt ?? -Infinity, agent.lastSyncAt ?? -Infinity);
  const nudge = [...pulses].reverse().find((p) => p.flow === "conflict");
  const inbound = pulses.filter((p) => p.flow === "in" || p.flow === "conflict" || p.flow === "error");
  const product = clientName(agent.client);
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(selected ? null : agent.connectionId)}
      title={selected ? "Show every assistant's activity" : `Show only ${agent.label}'s activity`}
      className={cn(
        "relative z-10 block rounded-md border bg-card text-left transition-[background-color,border-color,transform] duration-150 ease-out active:scale-[0.98]",
        sync.state === "behind" && "border-warn-rule shadow-[inset_3px_0_0_var(--warn)]",
        selected ? "border-archive bg-archive-tint" : "hover:bg-accent/60",
        className,
      )}
    >
      <Rings pulses={inbound} arrivalDelay={(p) => p.delay + (p.flow === "in" ? ARRIVE_MS : 0)} />
      <div key={nudge?.key} className={cn("px-3 py-2.5", nudge && "animate-live-nudge")} style={nudge ? { animationDelay: `${nudge.delay}ms` } : undefined}>
        <div className="flex min-w-0 items-center gap-1.5">
          <CustodyMark kind="agent" />
          <span className="truncate text-[0.8125rem] font-semibold leading-5" title={agent.label}>
            {agent.label}
          </span>
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs leading-4">
          <span className="truncate text-muted-foreground" title={agent.oauthClientName ? `Signed in as “${agent.oauthClientName}” (unverified)` : undefined}>
            {product}
          </span>
          <span
            className={cn("shrink-0", status === "active" ? "font-medium text-agent" : "text-muted-foreground")}
            title={Number.isFinite(lastHeard) ? `Last MCP call ${formatAbsolute(lastHeard)}` : undefined}
          >
            {STATUS_LABEL[status]}
          </span>
        </div>
        <PropagationBadge sync={sync} contextRevision={contextRevision} />
        <div className="mt-1 truncate text-xs leading-4 text-muted-foreground">
          {agent.lastSyncAt !== null ? (
            <span title={formatAbsolute(agent.lastSyncAt)}>Last synced {formatRelative(agent.lastSyncAt, now)}</span>
          ) : (
            "Hasn't called sync_workspace"
          )}
        </div>
      </div>
    </button>
  );
}

function PropagationBadge({ sync, contextRevision }: { sync: ReturnType<typeof propagation>; contextRevision: number }) {
  const received =
    sync.state === "current"
      ? sync.brief
        ? `Has received a brief of context v${contextRevision}: goal, scope, recent decisions and blockers, not constraints or ownership`
        : `Has received context v${contextRevision}`
      : sync.state === "behind"
        ? `Has received v${contextRevision - sync.behind}; v${contextRevision} is current`
        : "Has never received the project context";
  return (
    <div
      title={received}
      className={cn(
        "mt-2 inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-xs font-medium leading-4",
        sync.state === "current" && "border-transparent bg-archive-tint text-archive",
        sync.state === "behind" && "border-warn-rule bg-warn-tint text-warn",
        sync.state === "never" && "border-dashed border-unknown text-muted-foreground",
      )}
    >
      {sync.state === "current" && <CheckIcon className="size-3" aria-hidden />}
      {sync.state === "behind" && <ClockIcon className="size-3" aria-hidden />}
      {sync.state === "never" && <CircleDashedIcon className="size-3" aria-hidden />}
      {sync.label}
    </div>
  );
}

/** Pulses for calls that arrive while the page is open, staggered and self-clearing. */
function usePulses(workspaceId: string): Pulse[] {
  const [pulses, setPulses] = useState<Pulse[]>([]);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);
  useActivityArrivals(workspaceId, (items) => {
    const next = items.slice(-MAX_PULSES).map((item, i) => ({
      key: item.id,
      connectionId: item.actor.agentConnectionId,
      kind: item.kind,
      flow: KIND_META[item.kind].flow,
      delay: i * STAGGER_MS,
    }));
    setPulses((current) => [...current, ...next].slice(-MAX_PULSES));
    const keys = new Set(next.map((p) => p.key));
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setPulses((current) => current.filter((p) => !keys.has(p.key)));
    }, TRAVEL_MS + ARRIVE_MS + next.length * STAGGER_MS + 600);
    timers.current.add(timer);
  });
  return pulses;
}
