import { TandemApiError } from "./errors";
import type { TandemApi } from "./tandemApi";
import type {
  ActivityEvent,
  ActivityEventPage,
  ActivityEventQuery,
  ContextChange,
  ContextChanges,
  EntryHistory,
  EvidenceLevel,
  IntelActor,
  IntelRun,
  ObservedContext,
  ObservedEntry,
  ObservedStatus,
  Subscriber,
} from "./types";

const MINUTE = 60_000;
const MODEL = "claude-haiku-5-5";

type IntelligenceMethods = Pick<
  TandemApi,
  | "watchObservedContext"
  | "watchActivityEvents"
  | "listActivityEvents"
  | "watchContextChanges"
  | "watchEntryHistory"
  | "correctEntry"
  | "retractEntry"
  | "retryContextManager"
  | "backfillDocuments"
>;

export interface MockIntelligence extends IntelligenceMethods {
  /** Dev-only: a simulated Claude Code event, then a context-manager pass over it. */
  __simulateIntelActivity(workspaceId: string): void;
}

interface Deps {
  workspaceId: string;
  delay: () => Promise<void>;
  requireMember: (workspaceId: string) => void;
  requireAdmin: (workspaceId: string) => void;
  /** The signed-in person, for corrections. */
  currentActor: () => IntelActor;
  /** A reactive mock query: computed after the latency, again on every Live ping. */
  watchLive: <T>(workspaceId: string, compute: () => T, subscriber: Subscriber<T>) => () => void;
  pingLive: (workspaceId: string) => void;
}

const SYSTEM: IntelActor = { type: "system", label: "Tandem context manager", client: null, userName: null };
const ALEX_CLAUDE = { connectionId: "conn_alex_claude", label: "Alex's Claude", client: "claude" };
const SAM_CODE = { connectionId: "conn_sam_code", label: "Sam's Claude Code", client: "claude" };
const DEMO_CHATGPT = { connectionId: "conn_demo_chatgpt", label: "Demo Human's ChatGPT", client: "chatgpt" };
const agentActor = (a: typeof ALEX_CLAUDE, userName: string): IntelActor => ({ type: "agent", label: a.label, client: a.client, userName });
const ALEX: IntelActor = { type: "human", label: "Alex", client: null, userName: "Alex" };

type StoredEvent = ActivityEvent & { workspaceId: string };
type StoredEntry = ObservedEntry & { workspaceId: string };
type StoredChange = ContextChange & { workspaceId: string; evidenceEventIds: string[] };
type StoredRun = IntelRun & { workspaceId: string };

/**
 * The context-intelligence half of the mock: a plausible team's raw activity,
 * the observed state the context manager derived from it, and its history.
 * Mirrors intelligence.ts rules (membership, owner/admin retry, optimistic
 * revisions on correction).
 */
export function createMockIntelligence(deps: Deps): MockIntelligence {
  const now = Date.now();
  const ws = deps.workspaceId;
  let nextId = 1;
  const events: StoredEvent[] = [];
  const entries: StoredEntry[] = [];
  const changes: StoredChange[] = [];
  const runs: StoredRun[] = [];
  const state = {
    status: "idle" as ObservedContext["status"],
    revision: 0,
    consecutiveFailures: 0,
    nextRetryAt: null as number | null,
    lastRunAt: null as number | null,
  };

  const addEvent = (input: Partial<ActivityEvent> & Pick<ActivityEvent, "source" | "type" | "summary" | "actor">, at: number) => {
    const event: StoredEvent = {
      id: `ev_${nextId++}`, workspaceId: ws, tool: null, outcome: "ok", errorCode: null, agentConnectionId: null,
      resources: [], sessionId: null, correlationId: null, significant: true, intelStatus: "processed", intelRunId: null,
      payload: null, occurredAt: at, createdAt: at, ...input,
    };
    events.push(event);
    return event.id;
  };
  const addRun = (input: Partial<IntelRun> & Pick<IntelRun, "status" | "method">, at: number) => {
    const run: StoredRun = {
      id: `run_${nextId++}`, workspaceId: ws, model: input.method === "llm" ? MODEL : null, summary: null, error: null,
      eventCount: 0, contextChanges: 0, startedAt: at, finishedAt: input.status === "running" ? null : at + 4_000, ...input,
    };
    runs.push(run);
    state.lastRunAt = run.finishedAt ?? run.startedAt;
    return run;
  };
  const runRef = (run: StoredRun | null) => (run ? { id: run.id, status: run.status, method: run.method, model: run.model } : null);
  const sourceOf = (eventIds: string[]) => {
    const first = events.find((e) => e.id === eventIds[0]);
    return first ? { label: first.actor.label, source: first.source } : null;
  };
  /** Creates or revises an entry and appends its history row, like applyIntelResult. */
  const write = (
    key: string,
    fields: Partial<Omit<StoredEntry, "id" | "key" | "workspaceId" | "revision">> & { reason: string; change?: ContextChange["change"] },
    actor: IntelActor,
    run: StoredRun | null,
    at: number,
  ) => {
    const { reason, change: changeKind, ...patch } = fields;
    let entry = entries.find((e) => e.workspaceId === ws && e.key === key);
    if (!entry) {
      entry = {
        id: `entry_obs_${nextId++}`, workspaceId: ws, key, category: "knowledge", title: "", content: "", status: "active",
        evidence: "observed", confidence: 0.7, severity: null, supersededBy: null, revision: 0, evidenceEventIds: [], agents: [],
        files: [], contextEntryId: null, model: run?.model ?? null, createdBy: actor, updatedBy: actor, createdAt: at, updatedAt: at,
      };
      entries.push(entry);
    }
    const created = entry.revision === 0;
    const statusChanged = patch.status !== undefined && patch.status !== entry.status;
    Object.assign(entry, patch, { revision: entry.revision + 1, updatedBy: actor, updatedAt: at, model: run?.model ?? entry.model });
    state.revision++;
    changes.push({
      id: `rev_${nextId++}`, workspaceId: ws, entryId: entry.id, key, category: entry.category, revision: entry.revision,
      change: changeKind ?? (created ? "created" : statusChanged ? "status_changed" : "updated"),
      title: entry.title, content: entry.content, status: entry.status, evidence: entry.evidence, confidence: entry.confidence,
      reason, evidenceCount: entry.evidenceEventIds.length, evidenceEventIds: [...entry.evidenceEventIds], actor, run: runRef(run),
      evidenceSource: sourceOf(entry.evidenceEventIds), createdAt: at,
    });
    return entry;
  };

  // ---- Seed: forty minutes of one team's work. ----
  const sam = agentActor(SAM_CODE, "Sam");
  const alexClaude = agentActor(ALEX_CLAUDE, "Alex");
  const chatgpt = agentActor(DEMO_CHATGPT, "Demo Human");
  const t = (minutesAgo: number) => now - minutesAgo * MINUTE;
  const brief = { type: "file", id: "file_brief", label: "brief.md" };
  const proposalFile = { type: "file", id: "file_proposal", label: "proposal.md" };

  const failedRun = addRun({ status: "failed", method: "llm", error: "Model timed out after 20 s; events kept for the next batch" }, t(44));
  const e1 = addEvent({ source: "claude_code", type: "claude_code.session_start", summary: "Started a Claude Code session in tandem/", actor: sam, agentConnectionId: SAM_CODE.connectionId, sessionId: "cc-7f21", significant: false, intelStatus: "skipped", payload: JSON.stringify({ cwd: "~/tandem", model: "claude-sonnet-5-5" }) }, t(42));
  const e2 = addEvent({ source: "claude_code", type: "claude_code.prompt", summary: "Prompt: add refresh-token rotation to the auth middleware", actor: sam, agentConnectionId: SAM_CODE.connectionId, sessionId: "cc-7f21", payload: JSON.stringify({ prompt: "Add refresh-token rotation to the auth middleware and keep the version-conflict tests green", captured: "opt-in" }) }, t(41));
  const e3 = addEvent({ source: "mcp", type: "mcp.tool_call", tool: "sync_workspace", summary: "Synced the workspace (brief)", actor: alexClaude, agentConnectionId: ALEX_CLAUDE.connectionId, significant: false, intelStatus: "skipped", payload: JSON.stringify({ args: { detail: "brief" }, result: { context_revision: 2, cursor: 41 } }) }, t(39));
  const e4 = addEvent({ source: "claude_code", type: "claude_code.tool_use", tool: "Bash", outcome: "error", summary: "pnpm test failed: 2 failing in auth.test.ts", actor: sam, agentConnectionId: SAM_CODE.connectionId, sessionId: "cc-7f21", payload: JSON.stringify({ command: "pnpm test", exit_code: 1, failing: 2, stderr: "auth.test.ts › rotates refresh tokens" }) }, t(36));
  const e5 = addEvent({ source: "mcp", type: "mcp.tool_call", tool: "update_document", outcome: "conflict", errorCode: "VERSION_CONFLICT", summary: "Tried to save brief.md from v3; it's at v4", actor: alexClaude, agentConnectionId: ALEX_CLAUDE.connectionId, resources: [brief], payload: JSON.stringify({ args: { file_id: "file_brief", expected_version: 3, content: "[redacted: 1.2 KB]" }, result: { error: "VERSION_CONFLICT", current_version: 4 } }) }, t(33));
  const e6 = addEvent({ source: "workspace", type: "file.updated", summary: "Alex saved brief.md v4", actor: ALEX, resources: [brief], payload: JSON.stringify({ file_id: "file_brief", version: 4 }) }, t(34));
  const e7 = addEvent({ source: "mcp", type: "mcp.tool_call", tool: "update_document", summary: "Saved brief.md v5", actor: alexClaude, agentConnectionId: ALEX_CLAUDE.connectionId, resources: [brief], payload: JSON.stringify({ args: { file_id: "file_brief", expected_version: 4 }, result: { version: 5 } }) }, t(31));
  const e8 = addEvent({ source: "claude_code", type: "claude_code.tool_use", tool: "Edit", summary: "Edited convex/lib/auth.ts", actor: sam, agentConnectionId: SAM_CODE.connectionId, sessionId: "cc-7f21", payload: JSON.stringify({ file_path: "convex/lib/auth.ts", lines_changed: 38 }) }, t(28));
  const e9 = addEvent({ source: "claude_code", type: "claude_code.tool_use", tool: "Bash", summary: "pnpm test passed: 207 tests", actor: sam, agentConnectionId: SAM_CODE.connectionId, sessionId: "cc-7f21", payload: JSON.stringify({ command: "pnpm test", exit_code: 0, passed: 207 }) }, t(24));
  const e10 = addEvent({ source: "mcp", type: "mcp.tool_call", tool: "publish_work", summary: "Published finding: demo ChatGPT as the second client, read-only", actor: chatgpt, agentConnectionId: DEMO_CHATGPT.connectionId, payload: JSON.stringify({ args: { kind: "finding", title: "Demo ChatGPT as the second client, read-only" }, result: { id: "work_chatgpt" } }) }, t(20));
  const e11 = addEvent({ source: "claude_code", type: "claude_code.stop", summary: "Session finished: \"Refresh rotation is in; tests green.\"", actor: sam, agentConnectionId: SAM_CODE.connectionId, sessionId: "cc-7f21", payload: JSON.stringify({ last_message: "Refresh rotation is in; tests green.", duration_s: 1080 }) }, t(18));
  const e12 = addEvent({ source: "mcp", type: "mcp.tool_call", tool: "read_file", summary: "Read brief.md v5", actor: chatgpt, agentConnectionId: DEMO_CHATGPT.connectionId, resources: [brief], significant: false, intelStatus: "skipped" }, t(12));
  const e13 = addEvent({ source: "mcp", type: "mcp.tool_call", tool: "update_document", summary: "Saved proposal.md v3", actor: chatgpt, agentConnectionId: DEMO_CHATGPT.connectionId, resources: [proposalFile], payload: JSON.stringify({ args: { file_id: "file_proposal", expected_version: 2 }, result: { version: 3 } }) }, t(9));
  const e14 = addEvent({ source: "simulator", type: "claude_code.prompt", summary: "Simulated: Casey asked for a pitch outline", actor: { type: "agent", label: "Casey's Claude Code", client: "claude", userName: "Casey" }, sessionId: "sim-1", payload: JSON.stringify({ prompt: "Draft a three-minute pitch outline", simulated: true }), intelStatus: "pending" }, t(2));
  const e15 = addEvent({ source: "mcp", type: "mcp.tool_call", tool: "create_document", outcome: "error", errorCode: "INVALID_INPUT", summary: "Couldn't create a file: name was empty", actor: alexClaude, agentConnectionId: ALEX_CLAUDE.connectionId, intelStatus: "pending", payload: JSON.stringify({ args: { name: "" }, result: { error: "INVALID_INPUT" } }) }, t(1));
  void e1; void e3; void e12;

  const run1 = addRun({ status: "succeeded", method: "llm", eventCount: 4, summary: "Sam started on refresh-token rotation; Alex's Claude hit a conflict on brief.md and recovered." }, t(30));
  for (const id of [e2, e4, e5, e7]) Object.assign(events.find((e) => e.id === id)!, { intelRunId: run1.id });
  write("goal:p0-demo", { category: "goal", title: "Ship the Tandem P0 demo by Saturday night", content: "Matches the project goal; every assistant is working toward the live demo.", evidence: "human_confirmed", confidence: 1, reason: "Seeded from the project goal", evidenceEventIds: [], contextEntryId: "goal" }, SYSTEM, run1, t(30));
  write("objective:fallback-video", { category: "objective", title: "Record a fallback demo video", content: "Mentioned in brief.md and the open task list.", evidence: "requested", confidence: 0.6, reason: "Requested in brief.md", evidenceEventIds: [e7], files: [{ id: "file_brief", name: "brief.md", deleted: false }] }, SYSTEM, run1, t(30));
  write("task:refresh-rotation", { category: "task", title: "Refresh-token rotation in the auth middleware", content: "Sam's Claude Code is implementing rotation in convex/lib/auth.ts.", evidence: "observed", confidence: 0.8, reason: "Sam's prompt and the failing auth tests", evidenceEventIds: [e4, e2], agents: [SAM_CODE] }, SYSTEM, run1, t(30));
  write("blocker:auth-tests", { category: "blocker", title: "Two auth tests failing", content: "auth.test.ts › rotates refresh tokens fails after the middleware change.", evidence: "observed", confidence: 0.85, reason: "pnpm test exited 1", evidenceEventIds: [e4], agents: [SAM_CODE] }, SYSTEM, run1, t(30));
  write("coordination:brief-overlap", { category: "coordination", title: "Alex and Alex's Claude both editing brief.md", content: "A human save landed while the assistant held v3; it re-read and saved v5. Worth watching if it repeats.", evidence: "observed", confidence: 0.7, severity: "potential", reason: "VERSION_CONFLICT on brief.md, then a clean save", evidenceEventIds: [e7, e5, e6], agents: [ALEX_CLAUDE], files: [{ id: "file_brief", name: "brief.md", deleted: false }] }, SYSTEM, run1, t(30));

  const run2 = addRun({ status: "succeeded", method: "llm", eventCount: 5, summary: "Tests went green after Sam's edit; ChatGPT published a demo decision as a finding." }, t(16));
  for (const id of [e8, e9, e10, e11]) Object.assign(events.find((e) => e.id === id)!, { intelRunId: run2.id });
  write("task:refresh-rotation", { status: "completed", evidence: "verified", confidence: 0.95, content: "Implemented in convex/lib/auth.ts; the full suite passed (207 tests).", reason: "pnpm test passed after the edit", evidenceEventIds: [e9, e8, e4, e2] }, SYSTEM, run2, t(16));
  write("blocker:auth-tests", { status: "resolved", confidence: 0.95, reason: "The same suite passed", evidenceEventIds: [e9, e4] }, SYSTEM, run2, t(16));
  write("decision:chatgpt-read-only", { category: "decision", title: "Demo ChatGPT as the second client, read-only", content: "ChatGPT published it as a finding; Pro accounts only get read-only MCP. Nobody has agreed to it yet.", evidence: "claimed", confidence: 0.7, reason: "publish_work from ChatGPT", evidenceEventIds: [e10], agents: [DEMO_CHATGPT] }, SYSTEM, run2, t(16));
  write("agent:sam-code", { category: "agent_summary", title: "Sam's Claude Code", content: "Finished refresh-token rotation; session ended with tests green.", evidence: "verified", confidence: 0.9, reason: "Session stop after a passing test run", evidenceEventIds: [e11, e9], agents: [SAM_CODE] }, SYSTEM, run2, t(16));
  write("knowledge:pro-read-only", { category: "knowledge", title: "ChatGPT Pro connectors are read-only", content: "Full write MCP needs Business/Enterprise/Edu; plan the demo around reads from ChatGPT.", evidence: "observed", confidence: 0.75, reason: "ChatGPT's published finding", evidenceEventIds: [e10], agents: [DEMO_CHATGPT] }, SYSTEM, run2, t(16));
  write("coordination:auth-overlap", { category: "coordination", title: "Sam's Claude Code and Alex's Claude both changed the auth flow", content: "Sam's session rewrote token refresh in convex/lib/auth.ts while Alex's Claude saved brief.md describing the old flow; brief.md is now out of date.", evidence: "observed", confidence: 0.8, severity: "actual", reason: "Overlapping changes to the same feature", evidenceEventIds: [e8, e7], agents: [SAM_CODE, ALEX_CLAUDE] }, SYSTEM, run2, t(16));

  const run3 = addRun({ status: "succeeded", method: "llm", eventCount: 1, summary: "ChatGPT started writing up proposal.md." }, t(7));
  Object.assign(events.find((e) => e.id === e13)!, { intelRunId: run3.id });
  write("task:proposal-writeup", { category: "task", title: "Write up the demo proposal", content: "ChatGPT saved proposal.md v3 and says it's nearly done; nothing has checked it yet.", evidence: "claimed", confidence: 0.6, reason: "update_document on proposal.md", evidenceEventIds: [e13], agents: [DEMO_CHATGPT], files: [{ id: "file_proposal", name: "proposal.md", deleted: false }] }, SYSTEM, run3, t(7));
  write("blocker:gemini-eligibility", { category: "blocker", title: "Gemini connector blocked on account eligibility", content: "ChatGPT's notes say the Gemini custom MCP app isn't available on this account; nobody has a workaround yet.", evidence: "claimed", confidence: 0.55, reason: "Mentioned in proposal.md v3", evidenceEventIds: [e13], agents: [DEMO_CHATGPT], files: [{ id: "file_proposal", name: "proposal.md", deleted: false }] }, SYSTEM, run3, t(7));
  write("agent:alex-claude", { category: "agent_summary", title: "Alex's Claude", content: "Edits brief.md; recovered from one version conflict by re-reading.", evidence: "observed", confidence: 0.8, reason: "Recent MCP calls", evidenceEventIds: [e7, e5], agents: [ALEX_CLAUDE] }, SYSTEM, run3, t(7));
  write("knowledge:pro-read-only", { title: "ChatGPT Pro and Plus connectors are read-only", reason: "Alex checked the plan limits", change: "corrected", evidence: "human_confirmed", confidence: 1 }, ALEX, null, t(5));
  void failedRun; void e14; void e15;

  // ---- Reads ----
  const toEntry = ({ workspaceId: _w, ...entry }: StoredEntry): ObservedEntry => structuredClone(entry);
  const toChange = ({ workspaceId: _w, evidenceEventIds: _e, ...change }: StoredChange): ContextChange => structuredClone(change);
  const toEvent = ({ workspaceId: _w, ...event }: StoredEvent): ActivityEvent => structuredClone(event);
  const newestFirst = <T extends { createdAt: number }>(rows: T[]) => [...rows].reverse().sort((a, b) => b.createdAt - a.createdAt);

  const observed = (workspaceId: string): ObservedContext => {
    const last = newestFirst(runs.filter((r) => r.workspaceId === workspaceId).map((r) => ({ ...r, createdAt: r.startedAt })))[0];
    return {
      revision: workspaceId === ws ? state.revision : 0,
      lastRunAt: workspaceId === ws ? state.lastRunAt : null,
      status: workspaceId === ws ? state.status : "idle",
      consecutiveFailures: workspaceId === ws ? state.consecutiveFailures : 0,
      nextRetryAt: workspaceId === ws ? state.nextRetryAt : null,
      pendingEvents: Math.min(101, events.filter((e) => e.workspaceId === workspaceId && e.intelStatus === "pending").length),
      lastRun: last
        ? { status: last.status, method: last.method, model: last.model, summary: last.summary, error: last.error, finishedAt: last.finishedAt }
        : null,
      entries: [...entries]
        .filter((e) => e.workspaceId === workspaceId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 100)
        .map(toEntry),
    };
  };
  const eventPage = (workspaceId: string, { before, limit = 50, sources, connectionId }: ActivityEventQuery): ActivityEventPage => {
    const size = Math.min(Math.max(1, Math.floor(limit)), 100);
    // The mock's cursor is just createdAt; the backend's is opaque.
    const cutoff = before === undefined ? undefined : Number(before);
    const matching = newestFirst(events).filter(
      (e) => e.workspaceId === workspaceId && (cutoff === undefined || e.createdAt < cutoff) &&
        (!sources?.length || sources.includes(e.source)) && (!connectionId || e.agentConnectionId === connectionId),
    );
    const items = matching.slice(0, size).map(toEvent);
    return { items, nextBefore: matching.length > size ? String(items[items.length - 1]!.createdAt) : null };
  };
  const contextChanges = (workspaceId: string): ContextChanges => ({
    changes: newestFirst(changes.filter((c) => c.workspaceId === workspaceId)).slice(0, 30).map(toChange),
    runs: newestFirst(runs.filter((r) => r.workspaceId === workspaceId).map((r) => ({ ...r, createdAt: r.startedAt })))
      .slice(0, 20)
      .map(({ workspaceId: _w, createdAt: _c, ...run }) => ({ ...run })),
  });
  const findEntry = (workspaceId: string, entryId: string) => {
    const entry = entries.find((e) => e.id === entryId && e.workspaceId === workspaceId);
    if (!entry) throw new TandemApiError("INVALID_INPUT");
    return entry;
  };
  const history = (workspaceId: string, entryId: string): EntryHistory => {
    const entry = findEntry(workspaceId, entryId);
    const revisions = newestFirst(changes.filter((c) => c.entryId === entryId));
    const ids = new Set([...entry.evidenceEventIds, ...revisions.flatMap((r) => r.evidenceEventIds)]);
    return {
      entry: toEntry(entry),
      revisions: revisions.map(toChange),
      evidence: newestFirst(events.filter((e) => ids.has(e.id) && e.workspaceId === workspaceId)).map(toEvent),
    };
  };

  // ---- Writes ----
  const correct = (workspaceId: string, entryId: string, input: { expectedRevision: number; title?: string; content?: string; status?: ObservedStatus; note: string }) => {
    deps.requireMember(workspaceId);
    const entry = findEntry(workspaceId, entryId);
    if (entry.revision !== input.expectedRevision)
      throw new TandemApiError("VERSION_CONFLICT", { currentRevision: entry.revision });
    const note = input.note.trim();
    const title = input.title?.trim();
    const content = input.content?.trim();
    if (!note || note.length > 500 || title === "" || content === "") throw new TandemApiError("INVALID_INPUT");
    const confirmed = input.status !== undefined;
    const evidence: EvidenceLevel = confirmed ? "human_confirmed" : entry.evidence;
    write(entry.key, {
      ...(title !== undefined ? { title } : {}),
      ...(content !== undefined ? { content } : {}),
      ...(input.status ? { status: input.status } : {}),
      evidence, confidence: confirmed ? 1 : entry.confidence, reason: note, change: "corrected",
    }, deps.currentActor(), null, Date.now());
    deps.pingLive(workspaceId);
    return { revision: entry.revision };
  };

  const simulate = (workspaceId: string) => {
    deps.requireMember(workspaceId);
    const at = Date.now();
    const casey: IntelActor = { type: "agent", label: "Casey's Claude Code", client: "claude", userName: "Casey" };
    const id = addEvent({ source: "simulator", type: "claude_code.tool_use", tool: "Bash", summary: "Simulated: pnpm build passed", actor: casey, sessionId: "sim-1", intelStatus: "pending", payload: JSON.stringify({ command: "pnpm build", exit_code: 0, simulated: true }) }, at);
    state.status = "scheduled";
    deps.pingLive(workspaceId);
    setTimeout(() => {
      state.status = "running";
      deps.pingLive(workspaceId);
    }, 800);
    setTimeout(() => {
      const pending = events.filter((e) => e.workspaceId === workspaceId && e.intelStatus === "pending");
      const run = addRun({ status: "succeeded", method: "llm", eventCount: pending.length, summary: "Casey's (simulated) build passed." }, Date.now());
      for (const e of pending) Object.assign(e, { intelStatus: "processed", intelRunId: run.id });
      write("progress:pitch-build", { category: "progress", title: "Pitch site builds cleanly (simulated)", content: "A simulated Claude Code session ran pnpm build successfully.", evidence: "verified", confidence: 0.85, reason: "pnpm build exited 0 (simulated event)", evidenceEventIds: [id] }, SYSTEM, run, Date.now());
      state.status = "idle";
      deps.pingLive(workspaceId);
    }, 2200);
  };

  return {
    watchObservedContext: (workspaceId, subscriber) => deps.watchLive(workspaceId, () => observed(workspaceId), subscriber),
    watchActivityEvents: (workspaceId, query, subscriber) => deps.watchLive(workspaceId, () => eventPage(workspaceId, query), subscriber),
    async listActivityEvents(workspaceId, query) {
      await deps.delay();
      deps.requireMember(workspaceId);
      return eventPage(workspaceId, query);
    },
    watchContextChanges: (workspaceId, subscriber) => deps.watchLive(workspaceId, () => contextChanges(workspaceId), subscriber),
    watchEntryHistory: (workspaceId, entryId, subscriber) => deps.watchLive(workspaceId, () => history(workspaceId, entryId), subscriber),
    async correctEntry(workspaceId, entryId, correction) {
      await deps.delay();
      return correct(workspaceId, entryId, correction);
    },
    async retractEntry(workspaceId, entryId, input) {
      await deps.delay();
      return correct(workspaceId, entryId, { expectedRevision: input.expectedRevision, status: "retracted", note: input.note?.trim() || "Retracted by a person" });
    },
    async retryContextManager(workspaceId) {
      await deps.delay();
      deps.requireAdmin(workspaceId);
      if (workspaceId === ws) {
        state.consecutiveFailures = 0;
        state.nextRetryAt = null;
        state.status = "scheduled";
        deps.pingLive(workspaceId);
        setTimeout(() => {
          state.status = "idle";
          deps.pingLive(workspaceId);
        }, 1500);
      }
      return { scheduled: true };
    },
    async backfillDocuments(workspaceId) {
      await deps.delay();
      deps.requireAdmin(workspaceId);
      return { queued: 0, more: false };
    },
    __simulateIntelActivity: simulate,
  };
}
