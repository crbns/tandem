import { MAX_NAME_LENGTH, nameKey, storedName } from "@repo/backend/convex/lib/names.ts";
import { TandemApiError } from "./errors";

const MOCK_MCP_URL = "https://mock-deployment.convex.site/mcp";
import type { TandemApi } from "./tandemApi";
import {
  AGENT_CLIENTS,
  type ContextChangeInput,
  type ContextDetails,
  type ContextEntry,
  type PublishedWork,
  type Actor,
  type AgentConnection,
  type ContextProposal,
  type FileDetail,
  type FileSummary,
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
}

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
  content: string;
  revisions: Revision[]; // oldest first; append-only
}

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

export function createMockApi({
  latencyMs = [150, 400],
  getActor,
}: MockOptions): MockTandemApi {
  const files = seed(Date.now());
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
  const memberNames = new Map<string, string>();
  // Proposals keep the value they were based on (goal/scope only), like the
  // backend's baseValue, so a mock approval can go stale.
  type StoredProposal = ContextProposal & { baseValue?: string; ownerUserId?: string; ownerArea?: string };
  const proposals: StoredProposal[] = seedProposals(Date.now(), context);
  type StoredConnection = AgentConnection & { workspaceId: string };
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
    },
  ];
  const decidedRequests = new Set<string>();
  const watchers = new Map<string, Set<() => void>>();
  // Async like a backend push, so a watcher never runs inside the write itself.
  const notify = (workspaceId: string) =>
    watchers.get(workspaceId)?.forEach((listener) => queueMicrotask(listener));
  const cloneProposal = ({ baseValue: _baseValue, ownerUserId: _ownerUserId, ownerArea: _ownerArea, ...p }: StoredProposal): ContextProposal => ({
    ...p,
    sourceFileIds: [...p.sourceFileIds],
    createdBy: { ...p.createdBy },
    decidedBy: p.decidedBy ? { ...p.decidedBy } : null,
  });
  const cloneConnection = ({ workspaceId: _workspaceId, ...c }: StoredConnection): AgentConnection => ({ ...c });

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

  const validateName = (workspaceId: string, parentId: string | null, raw: string, exceptId?: string) => {
    const name = storedName(raw);
    const key = nameKey(name);
    if (!key || name.length > MAX_NAME_LENGTH) throw new TandemApiError("INVALID_INPUT");
    if ([...files.values()].some(f => f.deletedAt === undefined && f.summary.id !== exceptId && f.summary.workspaceId === workspaceId && f.summary.parentId === parentId && nameKey(f.summary.name) === key))
      throw new TandemApiError("NAME_EXISTS");
    return name;
  };
  const checkVersion = (file: StoredFile, expectedVersion: number) => {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new TandemApiError("INVALID_INPUT");
    if (file.summary.version !== expectedVersion) throw new TandemApiError("VERSION_CONFLICT", { currentVersion: file.summary.version });
  };

  const commit = (file: StoredFile, content: string, actor: Actor) => {
    const now = Date.now();
    const version = file.summary.version + 1;
    file.content = content;
    file.summary = {
      ...file.summary,
      version,
      updatedAt: now,
      updatedBy: actor,
    };
    file.revisions.push({ ...actor, version, createdAt: now, content });
    notify(file.summary.workspaceId);
    return version;
  };

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
        }));
    },

    async createFile(workspaceId, { name, mimeType, content }) {
      await delay();
      if (!workspaces.some((w) => w.id === workspaceId))
        throw new TandemApiError("FORBIDDEN");
      name = validateName(workspaceId, null, name);
      const id = `file_new_${nextId++}`;
      const actor = getActor();
      const now = Date.now();
      files.set(id, {
        content,
        revisions: [{ ...actor, version: 1, createdAt: now, content }],
        summary: {
          id,
          workspaceId,
          parentId: null,
          name,
          mimeType,
          version: 1,
          updatedAt: now,
          updatedBy: actor,
        },
      });
      notify(workspaceId);
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

    async readFile(fileId) {
      await delay();
      const file = getFile(fileId);
      const detail: FileDetail = {
        ...cloneSummary(file.summary),
        content: file.content,
        permissions: { canEdit: true },
      };
      return detail;
    },

    async updateFileContent(fileId, { expectedVersion, content }) {
      await delay();
      const file = getFile(fileId);
      if (expectedVersion !== file.summary.version) {
        throw new TandemApiError("VERSION_CONFLICT", {
          currentVersion: file.summary.version,
          currentContent: file.content,
          updatedBy: { ...file.summary.updatedBy },
        });
      }
      return { version: commit(file, content, getActor()) };
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
      const status = working ? "applied" as const : "pending" as const;
      if (working) {
        if (operation === "add") applyChange(workspaceId, { ...input, proposedValue }, actor);
        else {
          const entries = input.field === "constraint" ? ctx.constraints : ctx.openQuestions;
          const index = entries.findIndex((entry) => entry.id === input.entryId);
          if (operation === "remove") entries.splice(index, 1);
          else Object.assign(entries[index]!, { status: "resolved", resolvedBy: { ...actor }, resolvedAt: Date.now() });
          refreshSummary(workspaceId, actor);
        }
      }
      proposals.push({
        id, workspaceId, field: input.field, rationale: input.rationale, sourceFileIds: [...input.sourceFileIds],
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
      if (decision === "approved") {
        const current = proposal.field === "goal" ? ctx?.goal : proposal.field === "scope" ? ctx?.scope : undefined;
        if (current !== undefined && current !== proposal.baseValue) {
          proposal.status = "stale";
          notify(workspaceId);
          throw new TandemApiError("VERSION_CONFLICT");
        }
        const input = { ...proposal, proposedValue: proposal.ownerArea ?? proposal.proposedValue };
        // Sources were accepted when proposed; deletion must not strand approval.
        validateChange(workspaceId, input, proposal.sourceFileIds);
        const target = proposal.supersedes ? details.get(workspaceId)!.decisions.find((entry) => entry.id === proposal.supersedes) : undefined;
        if (proposal.supersedes && target?.status !== "active") {
          proposal.status = "stale";
          notify(workspaceId);
          throw new TandemApiError("VERSION_CONFLICT");
        }
        applyChange(workspaceId, input, actor);
        if (target) Object.assign(target, { status: "superseded", supersededBy: details.get(workspaceId)!.decisions.at(-1)!.id });
        // The compact summary exposes only active decisions.
        const summary = contexts.get(workspaceId)!;
        summary.decisions = details.get(workspaceId)!.decisions.filter((entry) => entry.status === "active").map((entry) => entry.text);
      }
      Object.assign(proposal, { status: decision, decidedBy: { ...actor }, decidedAt: now });
      notify(workspaceId);
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
  const base = { supersedes: null, workspaceId: MOCK_WORKSPACE_ID, decidedBy: null, decidedAt: null, status: "pending" as const };
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
