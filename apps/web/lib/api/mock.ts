import { MAX_NAME_LENGTH, nameKey, storedName } from "@repo/backend/convex/lib/names.ts";
import { normalizeError, TandemApiError } from "./errors";
import { clientName } from "../actors";
import { BINARY_MIME_TYPES, MAX_UPLOAD_BYTES } from "@repo/backend/convex/lib/binaries.js";

const MOCK_MCP_URL = "https://mock-deployment.convex.site/mcp";
import type { TandemApi } from "./tandemApi";
import {
  AGENT_CLIENTS,
  type ActivityKind,
  type AgentNetwork,
  type NetworkAgent,
  type Subscriber,
  type TimelineItem,
  type TimelinePage,
  type TimelineQuery,
  type ContextChangeInput,
  type ContextDetails,
  type ContextEntry,
  type PublishedWork,
  type Task,
  type Actor,
  type AgentConnection,
  type ContextApproval,
  type ContextField,
  type ContextProposal,
  type FileDetail,
  type FileSummary,
  type FolderSummary,
  type ProjectContext,
  type Revision,
  type Workspace,
  type WorkspaceInvite,
} from "./types";

export const MOCK_WORKSPACE_ID = "ws_demo";

export interface MockTandemApi extends TandemApi {
  /** Dev-only: pretend an assistant saved a new version through MCP. */
  __simulateExternalEdit(fileId: string, content: string, actor: Actor): void;
  __simulatePublishedWork(workspaceId: string, work: Omit<PublishedWork, "id" | "workspaceId" | "createdAt">): void;
  /** Dev-only: pretend a connected assistant made one MCP call (Live page controls). */
  __simulateAgentCall(connectionId: string, call: SimulatedCall): void;
}

export type SimulatedCall = "sync" | "read" | "write" | "stale_write";

/** A successful write within this long after the same assistant's conflict on that resource resolves it. */
const RESOLVE_WINDOW_MS = 30 * 60_000;

interface MockOptions {
  /** Inclusive [min, max] artificial latency per call. */
  latencyMs?: [number, number];
  /** Who the dashboard is acting as (the signed-in mock user). */
  getActor: () => Actor;
}

interface StoredFile {
  deletedAt?: number;
  deletedBy?: Actor;
  summary: FileSummary;
  content: string | null;
  blobs?: Map<number, Blob>;
  revisions: Revision[]; // oldest first; append-only
}

interface StoredFolder {
  deletedAt?: number;
  deletedBy?: Actor;
  /** The path is derived from the parent chain on read. */
  folder: Omit<FolderSummary, "path">;
}

// docs/filesystem.md limits, mirrored so the mock rejects what the backend does.
const MAX_FOLDER_DEPTH = 32;
const MAX_DELETE_ITEMS = 500;
const MAX_DIRECTORY_CHILDREN = 500;

// Alex's assistant: a teammate's Claude, so attribution has to say whose.
const CLAUDE: Actor = {
  actorType: "agent",
  userId: "user_alex",
  userName: "Alex",
  agentClient: "claude",
  agentName: "Claude",
};
const ALEX: Actor = {
  actorType: "human",
  userId: "user_alex",
  userName: "Alex",
};
const DEMO: Actor = {
  actorType: "human",
  userId: "user_demo",
  userName: "Demo Human",
};

const MINUTE = 60_000;

function seed(now: number): Map<string, StoredFile> {
  const files = new Map<string, StoredFile>();
  const add = (
    id: string,
    name: string,
    mimeType: string,
    history: Array<{ content: string; actor: Actor; at: number }>,
  ) => {
    const revisions: Revision[] = history.map((h, i) => ({
      ...h.actor,
      version: i + 1,
      createdAt: h.at,
      content: h.content,
    }));
    const head = history[history.length - 1]!;
    files.set(id, {
      content: head.content,
      revisions,
      summary: {
        id,
        workspaceId: MOCK_WORKSPACE_ID,
        parentId: null,
        name,
        mimeType,
        version: history.length,
        updatedAt: head.at,
        updatedBy: head.actor,
      },
    });
  };

  add("file_proposal", "proposal.md", "text/markdown", [
    {
      actor: CLAUDE,
      at: now - 3 * MINUTE,
      content:
        "# Project proposal\n\n## Goal\nShip the Tandem P0 demo by Saturday night.\n\n## Plan\n- MCP server with read/write tools\n- Dashboard with file list, editor, and history\n- Optimistic versioning on every write\n\n## Open questions\n- Which clients do we demo live?\n",
    },
  ]);
  add("file_brief", "brief.md", "text/markdown", [
    {
      actor: CLAUDE,
      at: now - 2 * 60 * MINUTE,
      content: "# Brief\n\nTandem keeps one canonical copy of team files.\n",
    },
    {
      actor: ALEX,
      at: now - 45 * MINUTE,
      content:
        "# Brief\n\nTandem keeps one canonical copy of team files that people **and** their assistants can read and write.\n\n| Who | Uses |\n|---|---|\n| Humans | Dashboard |\n| Assistants | MCP |\n",
    },
  ]);
  add("file_notes", "notes.txt", "text/plain", [
    {
      actor: DEMO,
      at: now - 26 * 60 * MINUTE,
      content:
        "Standup notes\n- Person 1: MCP auth\n- Person 2: schema\n- Person 3: dashboard\n",
    },
  ]);
  return files;
}

function seedFolders(now: number): Map<string, StoredFolder> {
  const folder = (id: string, name: string, parentId: string | null): [string, StoredFolder] => [
    id,
    { folder: { id, workspaceId: MOCK_WORKSPACE_ID, parentId, name, revision: 1, updatedAt: now - 60 * MINUTE, updatedBy: ALEX } },
  ];
  return new Map([folder("folder_specs", "specs", null)]);
}

export function createMockApi({
  latencyMs = [150, 400],
  getActor,
}: MockOptions): MockTandemApi {
  const files = seed(Date.now());
  const folders = seedFolders(Date.now());
  const workspaces: Workspace[] = [
    { id: MOCK_WORKSPACE_ID, name: "Cal Hacks Team" },
  ];
  // Mock approved context, taken from the seeded proposal so it tells one story.
  const context: ProjectContext = {
    goal: "Ship the Tandem P0 demo by Saturday night.",
    scope:
      "One workspace, two members, a shared text file edited from the dashboard and through MCP.",
    constraints: [
      "Every write carries expectedVersion",
      "No agent-to-agent messaging",
    ],
    decisions: [
      "Claude is the primary demo client",
      "Optimistic versioning on every write",
    ],
    version: 2,
    approvedBy: ALEX,
    approvedAt: Date.now() - 50 * MINUTE,
  };
  const contexts = new Map<string, ProjectContext>([
    [MOCK_WORKSPACE_ID, context],
  ]);
  let nextEntryId = 1;
  const entryIdentity = () => ({ id: `entry_${nextEntryId++}`, status: "active" as const, resolvedBy: null, resolvedAt: null, supersededBy: null });
  const seedEntry = (text: string): ContextEntry => ({
    ...entryIdentity(),
    text, sourceFileIds: ["file_proposal"], updatedBy: { ...ALEX }, updatedAt: context.approvedAt,
  });
  const details = new Map<string, ContextDetails>([[MOCK_WORKSPACE_ID, {
    goal: seedEntry(context.goal), scope: seedEntry(context.scope),
    constraints: context.constraints.map(seedEntry), decisions: context.decisions.map(seedEntry),
    ownership: [], openQuestions: [], version: context.version,
  }]]);
  const publishedWork: PublishedWork[] = [{
    id: "work_seed", workspaceId: MOCK_WORKSPACE_ID, kind: "finding", title: "Demo fallback",
    summary: "Keep a recorded fallback ready for venue Wi-Fi.", fileIds: ["file_proposal"],
    createdBy: { ...CLAUDE }, createdAt: Date.now() - 3 * MINUTE,
  }];
  const now = Date.now();
  const SAM: Actor = { actorType: "human", userId: "user_sam", userName: "Sam" };
  const tasks: Array<Task & { workspaceId: string }> = [
    {
      id: "task_seed_open", workspaceId: MOCK_WORKSPACE_ID, title: "Record the demo fallback video",
      description: "Two minutes, covering the MCP save and the version conflict.", status: "open",
      ownerId: null, ownerName: null, version: 1, createdBy: { ...CLAUDE }, updatedBy: { ...CLAUDE },
      createdAt: now - 20 * MINUTE, updatedAt: now - 20 * MINUTE, completedAt: null,
    },
    {
      id: "task_seed_claimed", workspaceId: MOCK_WORKSPACE_ID, title: "Draft the judging pitch",
      description: "", status: "in_progress", ownerId: ALEX.userId, ownerName: "Alex", version: 2,
      createdBy: { ...DEMO }, updatedBy: { ...CLAUDE },
      createdAt: now - 40 * MINUTE, updatedAt: now - 5 * MINUTE, completedAt: null,
    },
    {
      id: "task_seed_done", workspaceId: MOCK_WORKSPACE_ID, title: "Connect a second assistant",
      description: "ChatGPT through the OAuth consent page.", status: "done", ownerId: SAM.userId, ownerName: "Sam",
      version: 3, createdBy: { ...CLAUDE }, updatedBy: { ...SAM },
      createdAt: now - 90 * MINUTE, updatedAt: now - 30 * MINUTE, completedAt: now - 30 * MINUTE,
    },
  ];
  let nextId = 1;
  const invites = new Map<string, WorkspaceInvite & { token: string }>();
  const memberships = new Map<string, Map<string, "owner" | "admin" | "member">>();
  const signedInUser = () => {
    const actor = getActor();
    if (!actor.userId || actor.userId === "user_anonymous" || actor.actorType !== "human")
      throw new TandemApiError("UNAUTHENTICATED");
    return actor.userId;
  };
  const membersFor = (workspaceId: string) => {
    if (!workspaces.some((w) => w.id === workspaceId)) throw new TandemApiError("FORBIDDEN");
    if (!memberships.has(workspaceId)) memberships.set(workspaceId, new Map([[signedInUser(), "owner"]]));
    return memberships.get(workspaceId)!;
  };
  const requireAdmin = (workspaceId: string) => {
    const role = membersFor(workspaceId).get(signedInUser());
    if (role !== "owner" && role !== "admin") throw new TandemApiError("FORBIDDEN");
  };

  const requireMember = (workspaceId: string) => {
    const userId = signedInUser();
    if (!membersFor(workspaceId).has(userId)) throw new TandemApiError("FORBIDDEN");
  };
  const validateSources = (workspaceId: string, sourceFileIds: string[], existingFileIds: string[] = []) => {
    if (sourceFileIds.some((id) => {
      const file = files.get(id);
      return !file || file.summary.workspaceId !== workspaceId ||
        (file.deletedAt !== undefined && !existingFileIds.includes(id));
    })) throw new TandemApiError("INVALID_INPUT");
  };
  const validateChange = (workspaceId: string, input: ContextChangeInput, existingFileIds: string[] = []) => {
    if (!input.proposedValue.trim() || input.proposedValue.length > 10000)
      throw new TandemApiError("INVALID_INPUT");
    validateSources(workspaceId, input.sourceFileIds, existingFileIds);
    if (input.field === "ownership") {
      if (!input.ownerUserId || !membersFor(workspaceId).has(input.ownerUserId) || input.proposedValue.trim().length > 200)
        throw new TandemApiError("INVALID_INPUT");
    } else if (input.ownerUserId !== undefined) throw new TandemApiError("INVALID_INPUT");
  };
  const entryKey = { constraint: "constraints", decision: "decisions", ownership: "ownership", open_question: "openQuestions" } as const;
  const refreshSummary = (workspaceId: string, actor: Actor) => {
    const ctx = details.get(workspaceId)!;
    ctx.version++;
    contexts.set(workspaceId, {
      goal: ctx.goal?.text ?? "", scope: ctx.scope?.text ?? "",
      constraints: ctx.constraints.filter((e) => e.status === "active").map((e) => e.text),
      decisions: ctx.decisions.filter((e) => e.status === "active").map((e) => e.text), version: ctx.version,
      approvedBy: ctx.goal?.updatedBy ?? actor, approvedAt: ctx.goal?.updatedAt ?? Date.now(),
    });
  };
  const applyChange = (workspaceId: string, input: ContextChangeInput, actor: Actor, entryIndex?: number) => {
    const ctx = details.get(workspaceId)!;
    const now = Date.now();
    const text = input.proposedValue.trim();
    const existing = input.field === "goal" || input.field === "scope" || entryIndex === undefined ? undefined : ctx[entryKey[input.field]][entryIndex];
    const value: ContextEntry = { ...entryIdentity(), ...(existing ? { id: existing.id } : {}), text, sourceFileIds: [...input.sourceFileIds], updatedBy: { ...actor }, updatedAt: now };
    if (input.field === "goal" || input.field === "scope") ctx[input.field] = value;
    else {
      const key = { constraint: "constraints", decision: "decisions", ownership: "ownership", open_question: "openQuestions" } as const;
      const entries = ctx[key[input.field]];
      if (input.field === "ownership") {
        value.ownerUserId = input.ownerUserId;
        value.ownerArea = text;
        value.text = `${text}: ${memberNames.get(input.ownerUserId!) ?? "Workspace member"}`;
        ctx.ownership = [...entries.filter((entry, index) => index !== entryIndex && entry.ownerArea?.trim().toLowerCase() !== text.toLowerCase()), value];
      } else if (entryIndex === undefined) entries.push(value);
      else entries[entryIndex] = value;
    }
    refreshSummary(workspaceId, actor);
  };
  /** An addition, plus the decision it supersedes; throws VERSION_CONFLICT when that decision moved on. */
  const applyAddition = (workspaceId: string, input: ContextChangeInput & { supersedes?: string | null }, actor: Actor) => {
    const ctx = details.get(workspaceId)!;
    const target = input.supersedes ? ctx.decisions.find((entry) => entry.id === input.supersedes) : undefined;
    if (input.supersedes && target?.status !== "active") throw new TandemApiError("VERSION_CONFLICT");
    applyChange(workspaceId, input, actor);
    if (target) Object.assign(target, { status: "superseded", supersededBy: ctx.decisions.at(-1)!.id });
    // The compact summary exposes only active decisions.
    contexts.get(workspaceId)!.decisions = ctx.decisions.filter((entry) => entry.status === "active").map((entry) => entry.text);
  };
  /** Resolves or removes a constraint or open question; false when the entry is gone or already resolved. */
  const applyEntryOperation = (workspaceId: string, field: ContextField, operation: "resolve" | "remove", entryId: string, actor: Actor) => {
    const ctx = details.get(workspaceId)!;
    const entries = field === "constraint" ? ctx.constraints : ctx.openQuestions;
    const index = entries.findIndex((entry) => entry.id === entryId && (operation === "remove" || entry.status === "active"));
    if (index < 0) return false;
    if (operation === "remove") entries.splice(index, 1);
    else Object.assign(entries[index]!, { status: "resolved", resolvedBy: { ...actor }, resolvedAt: Date.now() });
    refreshSummary(workspaceId, actor);
    return true;
  };
  const memberNames = new Map<string, string>();
  // Proposals keep the value they were based on (goal/scope only), like the
  // backend's baseValue, so a mock approval can go stale.
  type StoredProposal = ContextProposal & { baseValue?: string; ownerUserId?: string; ownerArea?: string; entryId?: string };
  const proposals: StoredProposal[] = seedProposals(Date.now(), context);
  // Unset means "manual", like the backend's default.
  const contextApprovals = new Map<string, ContextApproval>();
  type StoredConnection = AgentConnection & { workspaceId: string; syncedContextRevision?: number };
  const connections: StoredConnection[] = [
    {
      id: "conn_alex_claude",
      workspaceId: MOCK_WORKSPACE_ID,
      userId: CLAUDE.userId,
      userName: CLAUDE.userName,
      client: "claude",
      displayName: "Alex's Claude",
      authKind: "oauth",
      oauthClientName: "Claude",
      createdAt: Date.now() - 26 * 60 * MINUTE,
      lastMcpActionAt: Date.now() - 3 * MINUTE,
      lastSyncAt: Date.now() - 12 * MINUTE,
      syncedContextRevision: context.version,
    },
  ];
  const decidedRequests = new Set<string>();
  const watchers = new Map<string, Set<() => void>>();
  // Async like a backend push, so a watcher never runs inside the write itself.
  // Live page subscriptions also see read-only calls, which record no workspace event.
  const liveWatchers = new Map<string, Set<() => void>>();
  const pingLive = (workspaceId: string) => liveWatchers.get(workspaceId)?.forEach((listener) => queueMicrotask(listener));
  const notify = (workspaceId: string) => {
    watchers.get(workspaceId)?.forEach((listener) => queueMicrotask(listener));
    pingLive(workspaceId);
  };
  const cloneProposal = ({ baseValue: _baseValue, ownerUserId: _ownerUserId, ownerArea: _ownerArea, entryId: _entryId, ...p }: StoredProposal): ContextProposal => ({
    ...p,
    sourceFileIds: [...p.sourceFileIds],
    createdBy: { ...p.createdBy },
    decidedBy: p.decidedBy ? { ...p.decidedBy } : null,
  });
  const cloneConnection = ({ workspaceId: _workspaceId, ...c }: StoredConnection): AgentConnection => ({ ...c });

  // The Live page's agent_activity and people's workspace events, newest last.
  type StoredActivity = TimelineItem & { workspaceId: string };
  const activity: StoredActivity[] = [];
  const connectionActor = (c: StoredConnection): TimelineItem["actor"] => ({
    type: "agent",
    label: c.displayName ?? `${c.userName ?? "Someone"}'s ${clientName(c.client)} assistant`,
    client: c.client,
    agentConnectionId: c.id,
  });
  /** The unrevoked connection an agent actor writes through, matched on person and client. */
  const connectionFor = (workspaceId: string, actor: Actor) =>
    connections.find((c) => c.workspaceId === workspaceId && c.revokedAt === undefined && c.userId === actor.userId && c.client === actor.agentClient);
  const contextVersion = (workspaceId: string) => details.get(workspaceId)?.version ?? 0;
  type ActivityInput = Pick<TimelineItem, "kind" | "summary"> & Partial<Omit<TimelineItem, "id" | "source" | "actor">>;
  const recordAgent = (c: StoredConnection, input: ActivityInput & { tool: string }) => {
    const now = input.createdAt ?? Date.now();
    let { kind, resolvesId = null } = input;
    if (kind === "write" && input.resource) {
      // The connection's own unresolved conflict on this resource, if recent.
      const conflict = [...activity].reverse().find((a) =>
        a.actor.agentConnectionId === c.id && a.kind === "conflict" && a.resource?.id === input.resource!.id &&
        now - a.createdAt <= RESOLVE_WINDOW_MS && !activity.some((b) => b.resolvesId === a.id));
      if (conflict) {
        kind = "resolved";
        resolvesId = conflict.id;
      }
    }
    activity.push({
      outcome: "ok", errorCode: null, resource: null, previousSyncedContextRevision: null,
      ...input, kind, resolvesId, createdAt: now,
      id: `a:${nextId++}`, source: "agent", workspaceId: c.workspaceId, actor: connectionActor(c),
      contextRevision: input.contextRevision ?? contextVersion(c.workspaceId),
    });
    if (input.createdAt === undefined) c.lastMcpActionAt = now;
    pingLive(c.workspaceId);
  };
  const recordHuman = (workspaceId: string, actor: Actor, input: ActivityInput) => {
    activity.push({
      outcome: "ok", errorCode: null, resource: null, previousSyncedContextRevision: null, resolvesId: null, tool: null,
      createdAt: Date.now(), ...input,
      id: `w:${nextId++}`, source: "workspace", workspaceId,
      actor: { type: actor.actorType, label: actor.userName ?? "A teammate", client: null, agentConnectionId: null },
      contextRevision: input.contextRevision ?? contextVersion(workspaceId),
    });
  };
  const fileResource = (f: StoredFile) => ({ type: "file", id: f.summary.id, label: f.summary.name });
  /** A save by anyone: people's become workspace events, an assistant's its connection's activity. */
  const recordSave = (f: StoredFile, actor: Actor, verb: "created" | "saved") => {
    const { workspaceId, name, version } = f.summary;
    const summary = verb === "created" ? `Created ${name}` : `Saved ${name} v${version}`;
    if (actor.actorType === "human") {
      recordHuman(workspaceId, actor, { kind: "human_edit", summary, resource: fileResource(f) });
      return;
    }
    const c = connectionFor(workspaceId, actor);
    if (c) recordAgent(c, { kind: "write", tool: verb === "created" ? "create_document" : "update_document", summary, resource: fileResource(f) });
  };

  const agentNetwork = (workspaceId: string): AgentNetwork => {
    const contextRevision = contextVersion(workspaceId);
    const agents = connections
      .filter((c) => c.workspaceId === workspaceId && c.revokedAt === undefined)
      .sort((a, b) => (b.lastMcpActionAt ?? -Infinity) - (a.lastMcpActionAt ?? -Infinity) || b.createdAt - a.createdAt)
      .slice(0, 50)
      .map((c): NetworkAgent => {
        const last = [...activity].reverse().find((a) => a.actor.agentConnectionId === c.id);
        return {
          connectionId: c.id,
          label: connectionActor(c).label,
          client: c.client,
          oauthClientName: c.oauthClientName ?? null,
          lastMcpActionAt: c.lastMcpActionAt ?? null,
          lastSyncAt: c.lastSyncAt ?? null,
          syncedContextRevision: c.syncedContextRevision ?? null,
          // Mock syncs are always full.
          syncedContextBrief: false,
          contextVersionsBehind: c.syncedContextRevision === undefined ? null : contextRevision - c.syncedContextRevision,
          lastTool: last?.tool ?? null,
          lastKind: last?.kind ?? null,
          lastOutcome: last?.outcome ?? null,
        };
      });
    const ctx = details.get(workspaceId);
    return { contextRevision, contextUpdatedAt: contexts.get(workspaceId)?.approvedAt ?? ctx?.goal?.updatedAt ?? null, agents };
  };
  const timeline = (workspaceId: string, { before: cursor, limit = 50, connectionId, kinds }: TimelineQuery): TimelinePage => {
    const size = Math.min(Math.max(1, Math.floor(limit)), 100);
    // The mock's cursor is just createdAt; the backend's is opaque.
    const before = cursor === undefined ? undefined : Number(cursor);
    // Newest first; same-millisecond calls keep the order they happened in.
    const matching = [...activity]
      .reverse()
      .filter((a) => a.workspaceId === workspaceId && (before === undefined || a.createdAt < before) &&
        (!connectionId || a.actor.agentConnectionId === connectionId) && (!kinds?.length || kinds.includes(a.kind)))
      .sort((a, b) => b.createdAt - a.createdAt);
    const items = matching.slice(0, size).map(({ workspaceId: _workspaceId, ...item }) => structuredClone(item));
    return { items, nextBefore: matching.length > size ? String(items[items.length - 1]!.createdAt) : null };
  };
  /** A reactive mock query: computed after the latency, again on every Live ping. */
  const watchLive = <T,>(workspaceId: string, compute: () => T, subscriber: Subscriber<T>) => {
    let active = true;
    const run = () => {
      void delay().then(() => {
        if (!active) return;
        let data: T;
        try {
          requireMember(workspaceId);
          data = compute();
        } catch (err) {
          subscriber.onError(normalizeError(err));
          return;
        }
        subscriber.onData(data);
      });
    };
    const listeners = liveWatchers.get(workspaceId) ?? new Set();
    liveWatchers.set(workspaceId, listeners);
    listeners.add(run);
    run();
    return () => {
      active = false;
      listeners.delete(run);
    };
  };

  const delay = () => {
    const [min, max] = latencyMs;
    const ms = min + Math.random() * (max - min);
    return ms > 0
      ? new Promise<void>((r) => setTimeout(r, ms))
      : Promise.resolve();
  };

  const getFile = (fileId: string): StoredFile => {
    const file = files.get(fileId);
    if (!file || file.deletedAt !== undefined) throw new TandemApiError("FILE_NOT_FOUND");
    return file;
  };

  // One namespace per folder: a file and a folder can't share a name either.
  const checkCollision = (workspaceId: string, parentId: string | null, name: string, exceptId?: string) => {
    const key = nameKey(name);
    const file = [...files.values()].find(f => f.deletedAt === undefined && f.summary.id !== exceptId && f.summary.workspaceId === workspaceId && f.summary.parentId === parentId && nameKey(f.summary.name) === key);
    if (file)
      throw new TandemApiError("NAME_EXISTS", { currentVersion: file.summary.version, existing: { kind: "file", id: file.summary.id, name: file.summary.name } });
    const folder = [...folders.values()].find(f => f.deletedAt === undefined && f.folder.id !== exceptId && f.folder.workspaceId === workspaceId && f.folder.parentId === parentId && nameKey(f.folder.name) === key);
    if (folder)
      throw new TandemApiError("NAME_EXISTS", { existing: { kind: "folder", id: folder.folder.id, name: folder.folder.name } });
  };
  const validateName = (workspaceId: string, parentId: string | null, raw: string, exceptId?: string) => {
    const name = storedName(raw);
    if (!nameKey(name) || name.length > MAX_NAME_LENGTH || name.includes("/") || name === "." || name === "..")
      throw new TandemApiError("INVALID_NAME");
    checkCollision(workspaceId, parentId, name, exceptId);
    return name;
  };

  const getFolder = (folderId: string, workspaceId?: string): StoredFolder => {
    const folder = folders.get(folderId);
    if (!folder || folder.deletedAt !== undefined || (workspaceId !== undefined && folder.folder.workspaceId !== workspaceId))
      throw new TandemApiError("FOLDER_NOT_FOUND");
    return folder;
  };
  /** A destination folder id, checked live and in this workspace; null is the root. */
  const parentIn = (workspaceId: string, parentId: string | null | undefined) =>
    parentId == null ? null : getFolder(parentId, workspaceId).folder.id;
  /** Root first, ending with `folderId` itself; empty for the root. */
  const ancestors = (folderId: string | null): StoredFolder[] => {
    const chain: StoredFolder[] = [];
    for (let id = folderId; id !== null; id = folders.get(id)!.folder.parentId) chain.unshift(folders.get(id)!);
    return chain;
  };
  const folderPath = (folderId: string | null) => `/${ancestors(folderId).map((f) => f.folder.name).join("/")}`;
  const filePath = ({ parentId, name }: FileSummary) => (parentId === null ? `/${name}` : `${folderPath(parentId)}/${name}`);
  const childFolders = (workspaceId: string, parentId: string | null) =>
    [...folders.values()].filter((f) => f.deletedAt === undefined && f.folder.workspaceId === workspaceId && f.folder.parentId === parentId);
  /** Levels of folders from `folder` down to its deepest descendant, itself included. */
  const height = (folder: StoredFolder): number =>
    1 + Math.max(0, ...childFolders(folder.folder.workspaceId, folder.folder.id).map(height));
  /** The folder and everything live inside it. */
  const subtree = (root: StoredFolder) => {
    const inside: StoredFolder[] = [];
    const queue = [root];
    while (queue.length) {
      const folder = queue.shift()!;
      inside.push(folder);
      queue.push(...childFolders(folder.folder.workspaceId, folder.folder.id));
    }
    const ids = new Set(inside.map((f) => f.folder.id));
    const contained = [...files.values()].filter((f) => f.deletedAt === undefined && f.summary.parentId !== null && ids.has(f.summary.parentId));
    return { folders: inside, files: contained };
  };
  const checkRevision = (folder: StoredFolder, expectedRevision: number) => {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new TandemApiError("INVALID_INPUT");
    if (folder.folder.revision !== expectedRevision)
      throw new TandemApiError("VERSION_CONFLICT", { currentRevision: folder.folder.revision });
  };
  const touchFolder = (folder: StoredFolder, actor: Actor) => {
    folder.folder = { ...folder.folder, revision: folder.folder.revision + 1, updatedAt: Date.now(), updatedBy: actor };
    notify(folder.folder.workspaceId);
  };
  const cloneFolder = (f: StoredFolder): FolderSummary => ({
    ...f.folder,
    updatedBy: { ...f.folder.updatedBy },
    path: folderPath(f.folder.id),
  });
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
  const checkVersion = (file: StoredFile, expectedVersion: number) => {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new TandemApiError("INVALID_INPUT");
    if (file.summary.version !== expectedVersion) throw new TandemApiError("VERSION_CONFLICT", { currentVersion: file.summary.version });
  };

  const commit = (file: StoredFile, content: string | null, actor: Actor) => {
    const now = Date.now();
    const version = file.summary.version + 1;
    const blob = file.blobs?.get(file.summary.version);
    if (blob) file.blobs!.set(version, blob);
    file.content = content;
    file.summary = {
      ...file.summary,
      version,
      updatedAt: now,
      updatedBy: actor,
    };
    file.revisions.push({ ...actor, version, createdAt: now, ...(content === null ? {} : { content }) });
    notify(file.summary.workspaceId);
    recordSave(file, actor, "saved");
    return version;
  };

  // The Live history the seed implies: the assistants' saves and proposals, the
  // seeded connection's last sync, people's saves and decisions.
  {
    const seeded: Array<{ at: number; record: () => void }> = [];
    for (const f of files.values()) {
      f.revisions.forEach((r, i) => {
        const actor: Actor = { actorType: r.actorType, userId: r.userId, userName: r.userName, agentClient: r.agentClient, agentName: r.agentName };
        const summary = i === 0 ? `Created ${f.summary.name}` : `Saved ${f.summary.name} v${r.version}`;
        const resource = fileResource(f);
        seeded.push({
          at: r.createdAt,
          record: () => {
            const c = actor.actorType === "agent" ? connectionFor(f.summary.workspaceId, actor) : undefined;
            if (c) recordAgent(c, { kind: "write", tool: i === 0 ? "create_document" : "update_document", summary, resource, createdAt: r.createdAt });
            else if (actor.actorType === "human") recordHuman(f.summary.workspaceId, actor, { kind: "human_edit", summary, resource, createdAt: r.createdAt });
          },
        });
      });
    }
    for (const p of proposals) {
      const c = p.createdBy.actorType === "agent" ? connectionFor(p.workspaceId, p.createdBy) : undefined;
      const resource = { type: "proposal", id: p.id, label: null };
      if (c) seeded.push({ at: p.createdAt, record: () => recordAgent(c, { kind: "propose", tool: "propose_context_change", summary: `Proposed a ${p.field.replace("_", " ")} change`, resource, createdAt: p.createdAt }) });
      if (p.decidedBy && p.decidedAt !== null && (p.status === "approved" || p.status === "rejected")) {
        const decidedAt = p.decidedAt;
        seeded.push({ at: decidedAt, record: () => recordHuman(p.workspaceId, p.decidedBy!, { kind: p.status === "approved" ? "approve" : "reject", summary: `${p.status === "approved" ? "Approved" : "Rejected"} a ${p.field.replace("_", " ")} proposal`, resource, createdAt: decidedAt }) });
      }
    }
    for (const c of connections) {
      const at = c.lastSyncAt;
      if (at !== undefined)
        seeded.push({ at, record: () => recordAgent(c, { kind: "sync", tool: "sync_workspace", summary: `Received context v${c.syncedContextRevision ?? 0}`, resource: { type: "context", id: c.workspaceId, label: null }, createdAt: at }) });
    }
    seeded.sort((a, b) => a.at - b.at).forEach((entry) => entry.record());
  }

  // Copies so callers can't mutate the store (revisions are immutable).
  const cloneSummary = (s: FileSummary): FileSummary => ({
    ...s,
    updatedBy: { ...s.updatedBy },
  });

  return {
    async listWorkspaces() {
      await delay();
      memberNames.set(signedInUser(), getActor().userName ?? "Workspace member");
      return workspaces.map((w) => ({ ...w, role: membersFor(w.id).get(signedInUser()) })).filter((w) => w.role);
    },

    async createWorkspace(name) {
      await delay();
      const trimmedName = name.trim();
      if (!trimmedName) throw new TandemApiError("INVALID_INPUT");
      const id = `ws_new_${nextId++}`;
      workspaces.push({ id, name: trimmedName });
      memberships.set(id, new Map([[signedInUser(), "owner"]]));
      details.set(id, { goal: null, scope: null, constraints: [], decisions: [], ownership: [], openQuestions: [], version: 1 });
      return id;
    },

    async createInvite(workspaceId, role) {
      await delay();
      requireAdmin(workspaceId);
      if (role !== "admin" && role !== "member") throw new TandemApiError("INVALID_INPUT");
      const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
      const now = Date.now();
      const id = `invite_${nextId++}`;
      const expiresAt = now + 7 * 24 * 60 * 60 * 1000;
      invites.set(id, { id, workspaceId, role, token, createdBy: signedInUser(), createdAt: now, updatedAt: now, expiresAt });
      return { inviteId: id, token, expiresAt };
    },

    async acceptInvite(token) {
      await delay();
      const userId = signedInUser();
      memberNames.set(userId, getActor().userName ?? "Workspace member");
      const invite = [...invites.values()].find((i) => i.token === token);
      if (!invite) throw new TandemApiError("INVITE_INVALID");
      if (invite.revokedAt !== undefined) throw new TandemApiError("INVITE_REVOKED");
      if (invite.expiresAt <= Date.now()) throw new TandemApiError("INVITE_EXPIRED");
      if (invite.acceptedAt !== undefined) throw new TandemApiError("INVITE_USED");
      const members = membersFor(invite.workspaceId);
      if (!members.has(userId)) {
        members.set(userId, invite.role);
        invite.acceptedBy = userId;
        invite.acceptedAt = invite.updatedAt = Date.now();
      }
      return { workspaceId: invite.workspaceId };
    },

    async listInvites(workspaceId) {
      await delay();
      requireAdmin(workspaceId);
      return [...invites.values()].filter((i) => i.workspaceId === workspaceId).reverse().slice(0, 100).map((invite) => ({
        id: invite.id, workspaceId, role: invite.role, createdBy: invite.createdBy,
        createdAt: invite.createdAt, expiresAt: invite.expiresAt, acceptedBy: invite.acceptedBy,
        acceptedAt: invite.acceptedAt, revokedAt: invite.revokedAt, updatedAt: invite.updatedAt,
      }));
    },

    async revokeInvite(inviteId) {
      await delay();
      signedInUser();
      const invite = invites.get(inviteId);
      if (!invite) throw new TandemApiError("INVITE_INVALID");
      requireAdmin(invite.workspaceId);
      if (invite.revokedAt === undefined) invite.revokedAt = invite.updatedAt = Date.now();
    },

    async listFiles(workspaceId) {
      await delay();
      if (!workspaces.some((w) => w.id === workspaceId))
        throw new TandemApiError("FORBIDDEN");
      return [...files.values()]
        .filter((f) => f.deletedAt === undefined && f.summary.workspaceId === workspaceId)
        .map((f) => ({
          ...cloneSummary(f.summary),
          custody: f.revisions.map((r) => r.actorType),
          path: filePath(f.summary),
        }));
    },

    async createFile(workspaceId, { name, mimeType, content, parentId: requestedParent }) {
      await delay();
      if (!workspaces.some((w) => w.id === workspaceId))
        throw new TandemApiError("FORBIDDEN");
      const parentId = parentIn(workspaceId, requestedParent);
      name = validateName(workspaceId, parentId, name);
      const id = `file_new_${nextId++}`;
      const actor = getActor();
      const now = Date.now();
      files.set(id, {
        content,
        revisions: [{ ...actor, version: 1, createdAt: now, content }],
        summary: {
          id,
          workspaceId,
          parentId,
          name,
          mimeType,
          version: 1,
          updatedAt: now,
          updatedBy: actor,
        },
      });
      notify(workspaceId);
      recordSave(files.get(id)!, actor, "created");
      return { id, version: 1 };
    },

    async renameFile(fileId, name, expectedVersion) {
      await delay();
      const file = getFile(fileId);
      requireMember(file.summary.workspaceId);
      checkVersion(file, expectedVersion);
      file.summary.name = validateName(file.summary.workspaceId, file.summary.parentId, name, fileId);
      return { version: commit(file, file.content, getActor()) };
    },

    async deleteFile(fileId, expectedVersion) {
      await delay();
      const file = getFile(fileId);
      requireMember(file.summary.workspaceId);
      checkVersion(file, expectedVersion);
      file.deletedAt = file.summary.updatedAt = Date.now();
      file.deletedBy = file.summary.updatedBy = { ...getActor() };
      notify(file.summary.workspaceId);
    },

    async uploadFile(workspaceId, blob, target) {
      await delay();
      requireMember(workspaceId);
      if (blob.size < 1 || blob.size > MAX_UPLOAD_BYTES || !BINARY_MIME_TYPES.has(blob.type || "application/octet-stream")) throw new TandemApiError("INVALID_INPUT");
      const actor = getActor();
      const now = Date.now();
      const existing = target && "fileId" in target ? getFile(target.fileId) : undefined;
      if (existing && existing.summary.workspaceId !== workspaceId) throw new TandemApiError("FORBIDDEN");
      if (existing && target && "fileId" in target && existing.summary.version !== target.expectedVersion) throw new TandemApiError("VERSION_CONFLICT");
      if (existing && existing.content !== null) throw new TandemApiError("INVALID_INPUT");
      const parentId = existing?.summary.parentId ?? parentIn(workspaceId, target && "parentId" in target ? target.parentId : null);
      const name = existing?.summary.name ?? validateName(workspaceId, parentId, blob.name);
      const id = existing?.summary.id ?? `file_new_${nextId++}`;
      const version = (existing?.summary.version ?? 0) + 1;
      const stored: StoredFile = existing ?? { content: null, revisions: [], summary: { id, workspaceId, parentId, name, mimeType: blob.type || "application/octet-stream", version, updatedAt: now, updatedBy: actor } };
      stored.summary = { ...stored.summary, name, mimeType: blob.type || "application/octet-stream", version, updatedAt: now, updatedBy: actor };
      stored.blobs ??= new Map();
      stored.blobs.set(version, blob);
      stored.revisions.push({ ...actor, version, createdAt: now });
      files.set(id, stored);
      notify(workspaceId);
      return { id, version };
    },

    async moveFile(fileId, parentId, expectedVersion) {
      await delay();
      const file = getFile(fileId);
      requireMember(file.summary.workspaceId);
      checkVersion(file, expectedVersion);
      const destination = parentIn(file.summary.workspaceId, parentId);
      // Moving keeps the name, so only collisions apply (legacy names stay valid).
      checkCollision(file.summary.workspaceId, destination, file.summary.name, fileId);
      file.summary.parentId = destination;
      return { version: commit(file, file.content, getActor()) };
    },

    async listDirectory(workspaceId, folderId) {
      await delay();
      if (!workspaces.some((w) => w.id === workspaceId))
        throw new TandemApiError("FORBIDDEN");
      const folder = folderId ? getFolder(folderId, workspaceId) : null;
      const parentId = folder?.folder.id ?? null;
      return {
        folder: folder ? cloneFolder(folder) : null,
        breadcrumbs: ancestors(parentId).map((f) => ({ id: f.folder.id, name: f.folder.name })),
        folders: childFolders(workspaceId, parentId).map(cloneFolder).sort(byName).slice(0, MAX_DIRECTORY_CHILDREN),
        files: [...files.values()]
          .filter((f) => f.deletedAt === undefined && f.summary.workspaceId === workspaceId && f.summary.parentId === parentId)
          .map((f) => ({ ...cloneSummary(f.summary), custody: f.revisions.map((r) => r.actorType), path: filePath(f.summary) }))
          .sort(byName)
          .slice(0, MAX_DIRECTORY_CHILDREN),
      };
    },

    async listFolderTree(workspaceId) {
      await delay();
      if (!workspaces.some((w) => w.id === workspaceId))
        throw new TandemApiError("FORBIDDEN");
      return [...folders.values()]
        .filter((f) => f.deletedAt === undefined && f.folder.workspaceId === workspaceId)
        .map(cloneFolder)
        .sort((a, b) => a.path.localeCompare(b.path));
    },

    async createFolder(workspaceId, { name, parentId: requestedParent }) {
      await delay();
      requireMember(workspaceId);
      const parentId = parentIn(workspaceId, requestedParent);
      if (ancestors(parentId).length + 1 > MAX_FOLDER_DEPTH) throw new TandemApiError("FOLDER_TOO_DEEP");
      const stored: StoredFolder = {
        folder: {
          id: `folder_new_${nextId++}`,
          workspaceId,
          parentId,
          name: validateName(workspaceId, parentId, name),
          revision: 1,
          updatedAt: Date.now(),
          updatedBy: { ...getActor() },
        },
      };
      folders.set(stored.folder.id, stored);
      notify(workspaceId);
      return cloneFolder(stored);
    },

    async renameFolder(folderId, name, expectedRevision) {
      await delay();
      const folder = getFolder(folderId);
      requireMember(folder.folder.workspaceId);
      checkRevision(folder, expectedRevision);
      folder.folder.name = validateName(folder.folder.workspaceId, folder.folder.parentId, name, folderId);
      touchFolder(folder, { ...getActor() });
      return cloneFolder(folder);
    },

    async moveFolder(folderId, parentId, expectedRevision) {
      await delay();
      const folder = getFolder(folderId);
      const { workspaceId } = folder.folder;
      requireMember(workspaceId);
      checkRevision(folder, expectedRevision);
      const destination = parentIn(workspaceId, parentId);
      const destinationChain = ancestors(destination);
      if (destinationChain.some((f) => f.folder.id === folderId)) throw new TandemApiError("INVALID_MOVE");
      if (destinationChain.length + height(folder) > MAX_FOLDER_DEPTH) throw new TandemApiError("FOLDER_TOO_DEEP");
      checkCollision(workspaceId, destination, folder.folder.name, folderId);
      folder.folder.parentId = destination;
      touchFolder(folder, { ...getActor() });
      return cloneFolder(folder);
    },

    async deleteFolder(folderId, expectedRevision) {
      await delay();
      const folder = getFolder(folderId);
      requireMember(folder.folder.workspaceId);
      checkRevision(folder, expectedRevision);
      const inside = subtree(folder);
      // All or nothing: nothing is written when the subtree is over the cap.
      if (inside.folders.length + inside.files.length > MAX_DELETE_ITEMS) throw new TandemApiError("FOLDER_TOO_LARGE");
      const now = Date.now();
      const actor = getActor();
      for (const f of inside.folders) Object.assign(f, { deletedAt: now, deletedBy: { ...actor } });
      for (const f of inside.files) {
        f.deletedAt = f.summary.updatedAt = now;
        f.deletedBy = f.summary.updatedBy = { ...actor };
      }
      notify(folder.folder.workspaceId);
      return { deletedFiles: inside.files.length, deletedFolders: inside.folders.length };
    },

    async getFileBlob(fileId, version) {
      await delay();
      const file = getFile(fileId);
      requireMember(file.summary.workspaceId);
      const blob = file.blobs?.get(version ?? file.summary.version);
      if (!blob) throw new TandemApiError("FILE_NOT_FOUND");
      return blob.slice(0, blob.size, blob.type);
    },

    async readFile(fileId) {
      await delay();
      const file = getFile(fileId);
      const detail: FileDetail = {
        ...cloneSummary(file.summary),
        path: filePath(file.summary),
        content: file.content,
        permissions: { canEdit: true },
      };
      return detail;
    },

    async updateFileContent(fileId, { expectedVersion, content }) {
      await delay();
      const file = getFile(fileId);
      if (file.content === null) throw new TandemApiError("BINARY_FILE");
      if (expectedVersion !== file.summary.version) {
        throw new TandemApiError("VERSION_CONFLICT", {
          currentVersion: file.summary.version,
          currentContent: file.content ?? undefined,
          updatedBy: { ...file.summary.updatedBy },
        });
      }
      return { version: commit(file, content, getActor()) };
    },

    async restoreRevision(fileId, version, expectedVersion) {
      await delay();
      const file = getFile(fileId);
      if (file.content === null) throw new TandemApiError("BINARY_FILE");
      if (!Number.isSafeInteger(version) || version < 1 ||
          !Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
        throw new TandemApiError("INVALID_INPUT");
      const revision = file.revisions.find((r) => r.version === version);
      if (!revision || revision.content === undefined) throw new TandemApiError("INVALID_INPUT");
      if (expectedVersion !== file.summary.version) {
        throw new TandemApiError("VERSION_CONFLICT", {
          currentVersion: file.summary.version,
          currentContent: file.content,
          updatedBy: { ...file.summary.updatedBy },
        });
      }
      return { version: commit(file, revision.content, getActor()) };
    },

    async listRevisions(fileId) {
      await delay();
      return getFile(fileId)
        .revisions.map((r) => ({ ...r }))
        .reverse();
    },

    async getRevision(fileId, version) {
      await delay();
      const revision = getFile(fileId).revisions.find(
        (r) => r.version === version,
      );
      return revision ? { ...revision } : null;
    },

    async getContext(workspaceId) {
      await delay();
      if (!workspaces.some((w) => w.id === workspaceId))
        throw new TandemApiError("FORBIDDEN");
      const approved = contexts.get(workspaceId);
      return approved
        ? { ...approved, approvedBy: { ...approved.approvedBy } }
        : null;
    },

    async getContextDetails(workspaceId) {
      await delay();
      requireMember(workspaceId);
      return structuredClone(details.get(workspaceId)!);
    },

    async listWorkspaceMembers(workspaceId) {
      await delay();
      requireMember(workspaceId);
      memberNames.set(signedInUser(), getActor().userName ?? "Workspace member");
      return [...membersFor(workspaceId).keys()].map((userId) => ({ userId, name: memberNames.get(userId) ?? "Workspace member" }));
    },

    async updateContextField(workspaceId, input) {
      await delay();
      if (getActor().actorType === "agent") throw new TandemApiError("APPROVAL_REQUIRED");
      requireAdmin(workspaceId);
      const ctx = details.get(workspaceId)!;
      if (input.expectedVersion !== ctx.version) throw new TandemApiError("VERSION_CONFLICT", { currentVersion: ctx.version });
      const key = { constraint: "constraints", decision: "decisions", ownership: "ownership", open_question: "openQuestions" } as const;
      if (input.entryIndex !== undefined && (input.field === "goal" || input.field === "scope" || !Number.isInteger(input.entryIndex) || input.entryIndex < 0 || input.entryIndex >= ctx[key[input.field]].length))
        throw new TandemApiError("INVALID_INPUT");
      let index = input.entryIndex;
      if (input.entryId !== undefined) {
        if (input.field === "goal" || input.field === "scope" || input.entryIndex !== undefined) throw new TandemApiError("INVALID_INPUT");
        index = ctx[key[input.field]].findIndex((entry) => entry.id === input.entryId);
        if (index < 0) throw new TandemApiError("INVALID_INPUT");
      }
      if (input.field !== "goal" && input.field !== "scope" && index !== undefined && ctx[key[input.field]][index]?.status !== "active")
        throw new TandemApiError("INVALID_INPUT");
      const existing = input.field === "goal" || input.field === "scope"
        ? ctx[input.field]
        : index !== undefined ? ctx[key[input.field]][index] : undefined;
      validateChange(workspaceId, input, existing?.sourceFileIds);
      applyChange(workspaceId, input, getActor(), index);
      notify(workspaceId);
      recordHuman(workspaceId, getActor(), {
        kind: "context", summary: `Edited the ${input.field.replace("_", " ")} in project context`,
        resource: { type: "context", id: workspaceId, label: null },
      });
      return { version: ctx.version };
    },

    async proposeContextChange(workspaceId, input) {
      await delay();
      const actor = getActor();
      // Agent proposals use the underlying person's existing membership.
      const members = memberships.get(workspaceId);
      if (actor.actorType === "agent") {
        if (!members?.has(actor.userId)) throw new TandemApiError("FORBIDDEN");
      } else requireMember(workspaceId);
      const ctx = details.get(workspaceId)!;
      const operation = input.operation ?? "add";
      if (input.expectedVersion !== undefined && input.expectedVersion !== ctx.version)
        throw new TandemApiError("VERSION_CONFLICT", { currentVersion: ctx.version });
      let proposedValue = input.proposedValue ?? "";
      const working = input.field === "constraint" || input.field === "open_question";
      if (operation !== "add") {
        if (!working || (operation === "resolve" && input.field !== "open_question") || !input.entryId || input.expectedVersion === undefined || input.supersedes)
          throw new TandemApiError("INVALID_INPUT");
        if (operation === "remove" && actor.actorType !== "human") throw new TandemApiError("INVALID_INPUT");
        const entries = input.field === "constraint" ? ctx.constraints : ctx.openQuestions;
        const index = entries.findIndex((entry) => entry.id === input.entryId && (operation === "remove" || entry.status === "active"));
        if (index < 0) throw new TandemApiError("INVALID_INPUT");
        validateSources(workspaceId, input.sourceFileIds, entries[index]!.sourceFileIds);
        proposedValue = entries[index]!.text;
      } else {
        const existing = input.field === "goal" || input.field === "scope" ? ctx[input.field] : undefined;
        validateChange(workspaceId, { ...input, proposedValue }, existing?.sourceFileIds);
        if (input.entryId !== undefined) throw new TandemApiError("INVALID_INPUT");
        if (input.supersedes !== undefined && (input.field !== "decision" || !ctx.decisions.some((entry) => entry.id === input.supersedes && entry.status === "active")))
          throw new TandemApiError("INVALID_INPUT");
      }
      const id = `proposal_${nextId++}`;
      const area = proposedValue.trim();
      const apply = contextApprovals.get(workspaceId) === "automatic";
      const status = apply ? "applied" as const : "pending" as const;
      if (apply) {
        if (operation === "add") applyAddition(workspaceId, { ...input, proposedValue }, actor);
        else applyEntryOperation(workspaceId, input.field, operation, input.entryId!, actor);
      }
      proposals.push({
        id, workspaceId, field: input.field, operation, rationale: input.rationale, sourceFileIds: [...input.sourceFileIds],
        ...(operation !== "add" ? { entryId: input.entryId } : {}),
        supersedes: input.supersedes ?? null,
        proposedValue: input.field === "ownership" ? `${area}: ${memberNames.get(input.ownerUserId!) ?? "Workspace member"}` : proposedValue,
        ...(input.field === "ownership" ? { ownerArea: area, ownerUserId: input.ownerUserId } : {}),
        ...(input.field === "goal" || input.field === "scope" ? { baseValue: ctx[input.field]?.text ?? "" } : {}),
        status, createdBy: { ...actor }, createdAt: Date.now(), decidedBy: null, decidedAt: null,
      });
      notify(workspaceId);
      return { id, status };
    },

    async listPublishedWork(workspaceId, cursor = null, pageSize = 20) {
      await delay();
      requireMember(workspaceId);
      const offset = cursor === null ? 0 : Number(cursor);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100)
        throw new TandemApiError("INVALID_INPUT");
      const rows = publishedWork.filter((work) => work.workspaceId === workspaceId).slice().reverse();
      const end = offset + pageSize;
      return { page: structuredClone(rows.slice(offset, end)), isDone: end >= rows.length, continueCursor: String(end) };
    },

    async listTasks(workspaceId) {
      await delay();
      requireMember(workspaceId);
      return tasks
        .filter((task) => task.workspaceId === workspaceId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 100)
        .map(({ workspaceId: _workspaceId, ...task }) => structuredClone(task));
    },

    async getContextApproval(workspaceId) {
      await delay();
      requireMember(workspaceId);
      return contextApprovals.get(workspaceId) ?? "manual";
    },

    async setContextApproval(workspaceId, mode) {
      await delay();
      requireAdmin(workspaceId);
      if (mode !== "manual" && mode !== "automatic") throw new TandemApiError("INVALID_INPUT");
      contextApprovals.set(workspaceId, mode);
      notify(workspaceId);
    },

    async listProposals(workspaceId, status) {
      await delay();
      membersFor(workspaceId);
      return proposals
        .filter((p) => p.workspaceId === workspaceId && (!status || p.status === status))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 100)
        .map(cloneProposal);
    },

    async decideProposal({ id, workspaceId }, decision) {
      await delay();
      const proposal = proposals.find((p) => p.id === id && p.workspaceId === workspaceId);
      if (!proposal) throw new TandemApiError("PROPOSAL_DECIDED");
      requireAdmin(workspaceId);
      if (proposal.status !== "pending") throw new TandemApiError("PROPOSAL_DECIDED");
      const actor = getActor();
      const now = Date.now();
      const ctx = contexts.get(workspaceId);
      if (decision === "approved" && proposal.operation !== "add") {
        if (!applyEntryOperation(workspaceId, proposal.field, proposal.operation, proposal.entryId!, actor)) {
          proposal.status = "stale";
          notify(workspaceId);
          throw new TandemApiError("VERSION_CONFLICT");
        }
      } else if (decision === "approved") {
        const current = proposal.field === "goal" ? ctx?.goal : proposal.field === "scope" ? ctx?.scope : undefined;
        if (current !== undefined && current !== proposal.baseValue) {
          proposal.status = "stale";
          notify(workspaceId);
          throw new TandemApiError("VERSION_CONFLICT");
        }
        const input = { ...proposal, proposedValue: proposal.ownerArea ?? proposal.proposedValue };
        // Sources were accepted when proposed; deletion must not strand approval.
        validateChange(workspaceId, input, proposal.sourceFileIds);
        try {
          applyAddition(workspaceId, input, actor);
        } catch (err) {
          proposal.status = "stale";
          notify(workspaceId);
          throw err;
        }
      }
      Object.assign(proposal, { status: decision, decidedBy: { ...actor }, decidedAt: now });
      notify(workspaceId);
      recordHuman(workspaceId, actor, {
        kind: decision === "approved" ? "approve" : "reject",
        summary: `${decision === "approved" ? "Approved" : "Rejected"} a ${proposal.field.replace("_", " ")} proposal`,
        resource: { type: "proposal", id: proposal.id, label: null },
      });
    },

    async getMcpServerUrl() {
      await delay();
      return MOCK_MCP_URL;
    },

    async createAgentConnection(workspaceId, { client, displayName }) {
      await delay();
      const userId = signedInUser();
      membersFor(workspaceId);
      if (!(AGENT_CLIENTS as readonly string[]).includes(client)) throw new TandemApiError("INVALID_INPUT");
      const name = displayName?.trim();
      if (name && name.length > 80) throw new TandemApiError("INVALID_INPUT");
      const token = `mcp_sk_${Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
      const createdAt = Date.now();
      const id = `conn_${nextId++}`;
      connections.push({
        id, workspaceId, userId, userName: getActor().userName, client, authKind: "api_key", createdAt,
        ...(name ? { displayName: name } : {}),
      });
      return { connectionId: id, token, createdAt, mcpUrl: MOCK_MCP_URL };
    },

    async listAgentConnections(workspaceId) {
      await delay();
      const userId = signedInUser();
      const role = membersFor(workspaceId).get(userId);
      const seesAll = role === "owner" || role === "admin";
      return connections
        .filter((c) => c.workspaceId === workspaceId && (seesAll || c.userId === userId))
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(cloneConnection);
    },

    async listAgentActivity(workspaceId) {
      await delay();
      requireMember(workspaceId);
      return connections
        .filter((c) => c.workspaceId === workspaceId && c.revokedAt === undefined)
        .map(({ client, lastMcpActionAt, lastSyncAt }) => ({
          client,
          ...(lastMcpActionAt !== undefined ? { lastMcpActionAt } : {}),
          ...(lastSyncAt !== undefined ? { lastSyncAt } : {}),
        }));
    },

    async revokeAgentConnection(connectionId) {
      await delay();
      const userId = signedInUser();
      const connection = connections.find((c) => c.id === connectionId);
      if (!connection) throw new TandemApiError("FORBIDDEN");
      if (connection.userId !== userId) requireAdmin(connection.workspaceId);
      connection.revokedAt ??= Date.now();
    },

    async getConsentRequest(requestId) {
      await delay();
      signedInUser();
      // Any request id works in mock mode, once; it looks like claude.ai asking.
      if (decidedRequests.has(requestId)) return null;
      return {
        status: "pending",
        clientName: "Claude",
        redirectHost: "claude.ai",
        suggestedClient: "claude",
        scopes: [
          { name: "tandem:read", description: "Read this workspace's files, project context and proposals" },
          {
            name: "tandem:write",
            description: "Create and update documents, publish work and propose context changes (never approve them)",
          },
        ],
        workspaces: workspaces
          .map((w) => ({ id: w.id, name: w.name, role: membersFor(w.id).get(signedInUser()) }))
          .filter((w): w is { id: string; name: string; role: "owner" | "admin" | "member" } => w.role !== undefined),
      };
    },

    async decideConsent(requestId, decision) {
      await delay();
      const userId = signedInUser();
      if (decidedRequests.has(requestId)) throw new TandemApiError("REQUEST_EXPIRED");
      if (!decision.approve) {
        decidedRequests.add(requestId);
        return { redirectUrl: "/" };
      }
      if (!membersFor(decision.workspaceId).has(userId)) throw new TandemApiError("FORBIDDEN");
      decidedRequests.add(requestId);
      connections.push({
        id: `conn_${nextId++}`,
        workspaceId: decision.workspaceId,
        userId,
        userName: getActor().userName,
        client: decision.client,
        authKind: "oauth",
        oauthClientName: "Claude",
        createdAt: Date.now(),
      });
      notify(decision.workspaceId);
      // No assistant to return to in mock mode: show the new connection.
      return { redirectUrl: `/w/${decision.workspaceId}/assistants` };
    },

    watchWorkspace(workspaceId, onChange) {
      const listeners = watchers.get(workspaceId) ?? new Set();
      watchers.set(workspaceId, listeners);
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },

    watchAgentNetwork(workspaceId, subscriber) {
      return watchLive(workspaceId, () => agentNetwork(workspaceId), subscriber);
    },

    watchTimeline(workspaceId, query, subscriber) {
      return watchLive(workspaceId, () => timeline(workspaceId, query), subscriber);
    },

    async listTimeline(workspaceId, query) {
      await delay();
      requireMember(workspaceId);
      return timeline(workspaceId, query);
    },

    __simulateAgentCall(connectionId, call) {
      const c = connections.find((conn) => conn.id === connectionId && conn.revokedAt === undefined);
      if (!c) throw new TandemApiError("FORBIDDEN");
      const { workspaceId } = c;
      if (call === "sync") {
        const previous = c.syncedContextRevision ?? null;
        c.syncedContextRevision = contextVersion(workspaceId);
        c.lastSyncAt = Date.now();
        recordAgent(c, {
          kind: "sync", tool: "sync_workspace", summary: `Received context v${c.syncedContextRevision}`,
          previousSyncedContextRevision: previous, resource: { type: "context", id: workspaceId, label: null },
        });
        return;
      }
      const file = [...files.values()]
        .filter((f) => f.deletedAt === undefined && f.summary.workspaceId === workspaceId && f.content !== null)
        .sort((a, b) => b.summary.updatedAt - a.summary.updatedAt)[0];
      if (!file) throw new TandemApiError("FILE_NOT_FOUND");
      const { name, version } = file.summary;
      if (call === "read") {
        recordAgent(c, { kind: "read", tool: "read_file", summary: `Read ${name} v${version}`, resource: fileResource(file) });
      } else if (call === "stale_write") {
        // The file stays as it was: a stale write commits nothing.
        recordAgent(c, {
          kind: "conflict", tool: "update_document", outcome: "conflict", errorCode: "VERSION_CONFLICT",
          summary: `Tried to save ${name} from v${Math.max(1, version - 1)}; it's at v${version}`, resource: fileResource(file),
        });
      } else {
        const actor: Actor = { actorType: "agent", userId: c.userId, userName: c.userName, agentClient: c.client, agentName: clientName(c.client) };
        commit(file, `${file.content ?? ""}\n> ${connectionActor(c).label} updated this file through MCP (simulated).\n`, actor);
      }
    },

    __simulatePublishedWork(workspaceId, work) {
      requireMember(workspaceId);
      publishedWork.push(structuredClone({ ...work, workspaceId, id: `work_${nextId++}`, createdAt: Date.now() }));
      notify(workspaceId);
    },

    __simulateExternalEdit(fileId, content, actor) {
      commit(getFile(fileId), content, actor);
    },
  };
}

function seedProposals(now: number, context: ProjectContext): Array<ContextProposal & { baseValue?: string }> {
  const base = { operation: "add" as const, supersedes: null, workspaceId: MOCK_WORKSPACE_ID, decidedBy: null, decidedAt: null, status: "pending" as const };
  return [
    {
      ...base,
      id: "proposal_goal",
      field: "goal",
      proposedValue: "Ship the Tandem P0 demo, plus a recorded fallback video, by Saturday night.",
      rationale: "Live demos fail on venue Wi-Fi. proposal.md now lists a recorded fallback as a deliverable.",
      sourceFileIds: ["file_proposal"],
      createdBy: { ...CLAUDE },
      createdAt: now - 8 * MINUTE,
      baseValue: context.goal,
    },
    {
      ...base,
      id: "proposal_decision",
      field: "decision",
      proposedValue: "Demo ChatGPT as the second client, read-only",
      rationale: "ChatGPT Pro only gets read-only MCP; the brief needs two clients and Claude covers writes.",
      sourceFileIds: ["file_brief"],
      createdBy: { ...CLAUDE },
      createdAt: now - 20 * MINUTE,
    },
    {
      // Based on an older scope, so approving it reports that the context moved on.
      ...base,
      id: "proposal_scope",
      field: "scope",
      proposedValue: "One workspace, one shared text file, edited only through MCP.",
      rationale: "Drafted before the team agreed the dashboard edits files too.",
      sourceFileIds: [],
      createdBy: { ...ALEX },
      createdAt: now - 70 * MINUTE,
      baseValue: "One workspace and a shared text file.",
    },
    {
      ...base,
      id: "proposal_constraint",
      field: "constraint",
      proposedValue: "No agent-to-agent messaging",
      rationale: "Cut from scope on purpose; assistants meet only through files and context.",
      sourceFileIds: [],
      createdBy: { ...CLAUDE },
      createdAt: now - 3 * 60 * MINUTE,
      status: "approved",
      decidedBy: { ...ALEX },
      decidedAt: now - 2 * 60 * MINUTE,
    },
  ];
}
