// The handoff doc's P0 vertical slice, end to end, against the live local
// Convex deployment, the MCP server it serves at <site>/mcp (@convex-dev/mcp,
// with OAuth) and the dashboard's own data layer. Steps share state and run
// in order.
import { writeFileSync } from "node:fs";
import { api } from "@repo/backend/convex/_generated/api.js";
import type { Id } from "@repo/backend/convex/_generated/dataModel.js";
import { ConvexHttpClient } from "convex/browser";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { TandemApiError } from "../../../apps/web/lib/api/errors";
import { Agent, rawMcpStatus } from "../src/agent";
import { passwordSignIn, signUp, type Human } from "../src/humans";
import {
  isAccountExistsError,
  isWeakPasswordError,
} from "../../../apps/web/lib/auth/signInErrors";

const convexUrl = inject("convexUrl");
const mcpUrl = inject("mcpUrl");

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const password = `e2e-password-${run}`;
const person = (who: string, name: string) => ({
  email: `${who}-${run}@e2e.tandem.test`,
  password,
  name: `${name} ${run}`,
});

const TOOL_SURFACE = [
  "sync_workspace",
  "list_files",
  "search_files",
  "read_file",
  "create_document",
  "update_document",
  "create_folder",
  "move_file",
  "move_folder",
  "publish_work",
  "propose_context_change",
  "get_approvals",
  "get_file_versions",
  "get_workspace_info",
  "manage_task",
];

const INITIAL_GOAL = `Ship the Tandem P0 slice (${run})`;
const NEW_GOAL = `Ship the P0 slice with two native clients (${run})`;
const NEW_SCOPE = `Shared text documents and human-approved context (${run})`;
const V1 = `# Proposal\n\nDrafted by A's assistant (${run}).\n`;
const V2 = `# Proposal\n\nDrafted by A's assistant, edited by B in the dashboard (${run}).\n`;

type Attribution = {
  actor_type: string;
  user_id: string;
  client: string;
  agent_connection_id?: string;
  label?: string;
};
type McpFile = {
  id: string;
  workspace_id: string;
  name: string;
  version: number;
  updated_by: Attribution;
};
type McpEvent = {
  seq: number;
  type: string;
  actor: Attribution;
  subject_id: string;
};
type McpSync = {
  workspace: { id: string };
  context: {
    goal: string;
    scope: string;
    open_questions: {
      id: string;
      text: string;
      status: string;
      resolved_by: Attribution | null;
      resolved_at: number | null;
    }[];
    decisions: {
      id: string;
      text: string;
      status: string;
      superseded_by: string | null;
    }[];
  };
  context_version: number;
  pending_proposals: { id: string }[];
  recent_work: {
    kind: string;
    title: string;
    summary: string;
    file_ids: string[];
    published_by: Attribution;
    created_at: string;
  }[];
  work_truncated: boolean;
  events: McpEvent[];
  events_truncated: boolean;
  cursor: string;
};

/** Rejects with a TandemApiError; returns its code. */
async function dashboardCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(TandemApiError);
    return (err as TandemApiError).code;
  }
  throw new Error("expected the dashboard call to fail");
}

const evidence: Record<string, unknown> = { run, convexUrl, mcpUrl };

describe("P0 vertical slice: MCP + Convex + dashboard", () => {
  let a: Human;
  let b: Human;
  let c: Human;
  let workspaceId: string;
  let cWorkspaceId: string;
  let token: string;
  let connectionId: string;
  let agent: Agent;
  let fileId: string;
  let cursorBeforeProposal: string;
  let teammateConnectionId: string;
  let proposalId: string;

  beforeAll(async () => {
    a = await signUp(convexUrl, person("a", "Avery"));
    b = await signUp(convexUrl, person("b", "Blake"));
    c = await signUp(convexUrl, person("c", "Casey"));
  });

  afterAll(async () => {
    await agent?.close();
    await Promise.all([a?.close(), b?.close(), c?.close()]);
    if (process.env.E2E_EVIDENCE)
      writeFileSync(
        process.env.E2E_EVIDENCE,
        `${JSON.stringify(evidence, null, 2)}\n`,
      );
  });

  it("0. sign-up rejects a short password (coded WEAK_PASSWORD) and an existing email", async () => {
    const weak = await passwordSignIn(convexUrl, {
      ...person("weak", "Wes"),
      password: "short",
      flow: "signUp",
    }).catch((err: unknown) => err);
    expect(isWeakPasswordError(weak)).toBe(true);
    expect((weak as { data?: { code?: string } }).data?.code).toBe(
      "WEAK_PASSWORD",
    );

    // Convex Auth treats a sign-up with an existing email and the RIGHT password
    // as a sign-in; only a different password is "already exists".
    const dup = await passwordSignIn(convexUrl, {
      ...person("a", "Avery"),
      password: `${password}-other`,
      flow: "signUp",
    }).catch((err: unknown) => err);
    expect(dup).toBeInstanceOf(Error);
    // Local deployments keep the message; production redacts it (the form then
    // falls back to "if you already have an account, sign in instead").
    expect(isAccountExistsError(dup)).toBe(true);
  });

  it("1. A creates a workspace with an approved goal and invites B; C has their own workspace", async () => {
    workspaceId = await a.dashboard.createWorkspace(`E2E ${run}`);
    const goalProposal = await a.http.mutation(
      api.context.proposeContextChange,
      {
        workspaceId: workspaceId as Id<"workspaces">,
        field: "goal",
        proposedValue: INITIAL_GOAL,
        rationale: "Kickoff",
        sourceFileIds: [],
      },
    );
    await a.dashboard.decideProposal(
      { id: goalProposal.id, workspaceId },
      "approved",
    );
    const context = await a.dashboard.getContext(workspaceId);
    expect(context?.goal).toBe(INITIAL_GOAL);
    expect(context?.approvedBy).toMatchObject({
      actorType: "human",
      userName: a.name,
    });

    const invite = await a.dashboard.createInvite(workspaceId, "member");
    expect(await b.dashboard.acceptInvite(invite.token)).toEqual({
      workspaceId,
    });
    expect(await b.dashboard.listWorkspaces()).toEqual([
      { id: workspaceId, name: `E2E ${run}`, role: "member" },
    ]);

    cWorkspaceId = await c.dashboard.createWorkspace(`Outsider ${run}`);
    expect((await c.dashboard.listWorkspaces()).map((w) => w.id)).toEqual([
      cWorkspaceId,
    ]);
    evidence.step1 = {
      workspaceId,
      cWorkspaceId,
      goal: context?.goal,
      bRole: "member",
    };
  });

  it("2. A creates an agent connection and the MCP SDK client connects with the token", async () => {
    const connection = await a.dashboard.createAgentConnection(workspaceId, {
      client: "claude",
      displayName: "Avery's Claude",
    });
    token = connection.token;
    connectionId = connection.connectionId;
    expect(token).toMatch(/^mcp_sk_[A-Za-z0-9_-]{43}$/);
    expect(connection.mcpUrl).toBe(mcpUrl);
    // The token is shown once: listing never returns it or its hash.
    const listed = await a.dashboard.listAgentConnections(workspaceId);
    expect(JSON.stringify(listed)).not.toContain(token.slice(7));
    expect(JSON.stringify(listed)).not.toMatch(/tokenHash/i);

    agent = await Agent.connect(mcpUrl, token);
    expect(agent.client.getServerVersion()?.name).toBeTruthy();
    evidence.step2 = { connectionId, server: agent.client.getServerVersion() };
  });

  it("3. agent: full tool surface, sync shows the approved goal, create_document → v1", async () => {
    const { tools } = await agent.client.listTools();
    const names = tools.map((t) => t.name);
    expect([...names].sort()).toEqual([...TOOL_SURFACE].sort());

    const sync = await agent.ok<McpSync>("sync_workspace");
    expect(sync.workspace.id).toBe(workspaceId);
    expect(sync.context.goal).toBe(INITIAL_GOAL);

    const file = await agent.ok<McpFile>("create_document", {
      name: "proposal.md",
      content: V1,
    });
    expect(file).toMatchObject({
      name: "proposal.md",
      version: 1,
      workspace_id: workspaceId,
    });
    // The connection that wrote it, not just the person and client.
    expect(file.updated_by).toEqual({
      actor_type: "agent",
      user_id: expect.any(String),
      client: "claude",
      agent_connection_id: connectionId,
      label: expect.any(String),
    });
    fileId = file.id;
    evidence.step3 = { tools: names, goal: sync.context.goal, file };
  });

  it("4. B in the dashboard: sees proposal.md by A via the agent, reads it, saves v2", async () => {
    const files = await b.dashboard.listFiles(workspaceId);
    const listed = files.find((f) => f.id === fileId);
    expect(listed).toMatchObject({
      name: "proposal.md",
      version: 1,
      updatedBy: {
        actorType: "agent",
        userName: a.name,
        agentClient: "claude",
      },
    });

    const detail = await b.dashboard.readFile(fileId);
    expect(detail).toMatchObject({ version: 1, content: V1 });

    expect(
      await b.dashboard.updateFileContent(fileId, {
        content: V2,
        expectedVersion: 1,
      }),
    ).toEqual({
      version: 2,
    });
    // A second proposal.md (names are case/space-insensitive) is refused, not duplicated.
    expect(
      await dashboardCode(
        b.dashboard.createFile(workspaceId, {
          name: " PROPOSAL.md ",
          mimeType: "text/markdown",
          content: "dup",
        }),
      ),
    ).toBe("NAME_EXISTS");
    expect(
      (await b.dashboard.listFiles(workspaceId)).filter((f) =>
        /proposal\.md/i.test(f.name),
      ),
    ).toHaveLength(1);
    evidence.step4 = {
      listedBy: listed?.updatedBy,
      savedVersion: 2,
      duplicateName: "NAME_EXISTS",
    };
  });

  it("5. agent reads v2; a stale update gets VERSION_CONFLICT(current 2) and v2 stays intact", async () => {
    const read = await agent.ok<{ file: McpFile; content: string }>(
      "read_file",
      { file_id: fileId },
    );
    expect(read.file.version).toBe(2);
    expect(read.content).toBe(V2);
    expect(read.file.updated_by).toMatchObject({
      actor_type: "human",
      client: "dashboard",
    });

    const conflict = await agent.fails("update_document", {
      file_id: fileId,
      content: "stale overwrite",
      expected_version: 1,
    });
    expect(conflict).toMatchObject({
      code: "VERSION_CONFLICT",
      current_version: 2,
      expected_version: 1,
    });

    const reread = await agent.ok<{ file: McpFile; content: string }>(
      "read_file",
      { file_id: fileId },
    );
    expect(reread).toMatchObject({ file: { version: 2 }, content: V2 });
    expect((await b.dashboard.readFile(fileId)).content).toBe(V2);
    evidence.step5 = { conflict };
  });

  it("6. MCP and dashboard history both attribute v1 to A's agent and v2 to B", async () => {
    const userIdA = (await a.dashboard.listAgentConnections(workspaceId)).find(
      (x) => x.id === connectionId,
    )?.userId;
    const history = await agent.ok<{
      versions: { version: number; author: Attribution; content?: string }[];
    }>("get_file_versions", { file_id: fileId });
    const byVersion = new Map(history.versions.map((v) => [v.version, v]));
    expect(byVersion.get(1)?.author).toEqual({
      actor_type: "agent",
      user_id: userIdA,
      client: "claude",
      agent_connection_id: connectionId,
      label: expect.any(String),
    });
    expect(byVersion.get(2)?.author).toMatchObject({
      actor_type: "human",
      client: "dashboard",
    });
    expect(byVersion.get(2)?.author.user_id).not.toBe(userIdA);
    for (const v of history.versions) expect(v).not.toHaveProperty("content");

    const revisions = await b.dashboard.listRevisions(fileId);
    const v1 = revisions.find((r) => r.version === 1);
    const v2 = revisions.find((r) => r.version === 2);
    expect(v1).toMatchObject({
      actorType: "agent",
      userId: userIdA,
      userName: a.name,
      agentClient: "claude",
    });
    expect(v2).toMatchObject({ actorType: "human", userName: b.name });
    expect(v2?.userId).toBe(byVersion.get(2)?.author.user_id);
    evidence.step6 = { mcp: history.versions, dashboard: revisions };
  });

  it("7. approval loop: agent proposes, cannot decide; member B is forbidden; A approves; agent syncs", async () => {
    cursorBeforeProposal = (await agent.ok<McpSync>("sync_workspace")).cursor;

    const { proposal } = await agent.ok<{
      proposal: { id: string; status: string; field: string };
    }>("propose_context_change", {
      field: "goal",
      proposed_value: NEW_GOAL,
      rationale: "Scope agreed in proposal.md",
      source_ids: [fileId],
    });
    expect(proposal).toMatchObject({
      status: "pending",
      field: "goal",
      proposed_value: NEW_GOAL,
      proposed_by: { actor_type: "agent", client: "claude" },
    });
    proposalId = proposal.id;
    const pending = await a.dashboard.listProposals(workspaceId, "pending");
    expect(pending.find((p) => p.id === proposalId)).toMatchObject({
      createdBy: { actorType: "agent", userName: a.name },
      sourceFileIds: [fileId],
    });

    // The agent has no way to decide: no tool for it, and Convex refuses the
    // decide mutation without a human session (the agent token isn't one).
    const toolNames = (await agent.client.listTools()).tools.map((t) => t.name);
    expect(toolNames.filter((n) => /approve|decide/.test(n))).toEqual([]);
    // Calling one anyway is a JSON-RPC "unknown tool" error, not a tool result.
    await expect(
      agent.client.callTool({ name: "decide_context_proposal", arguments: { proposal_id: proposalId } }),
    ).rejects.toMatchObject({ code: -32602 });
    const withAgentToken = new ConvexHttpClient(convexUrl, { logger: false });
    withAgentToken.setAuth(token);
    await expect(
      withAgentToken.mutation(api.context.decideContextProposal, {
        proposalId: proposalId as Id<"context_proposals">,
        decision: "approved",
      }),
    ).rejects.toThrow();
    const anonymous = new ConvexHttpClient(convexUrl, { logger: false });
    await expect(
      anonymous.mutation(api.context.decideContextProposal, {
        proposalId: proposalId as Id<"context_proposals">,
        decision: "approved",
      }),
    ).rejects.toThrow(/UNAUTHENTICATED/);

    // B is a member, not an admin.
    expect(
      await dashboardCode(
        b.dashboard.decideProposal({ id: proposalId, workspaceId }, "approved"),
      ),
    ).toBe("FORBIDDEN");
    expect((await a.dashboard.getContext(workspaceId))?.goal).toBe(
      INITIAL_GOAL,
    );

    await a.dashboard.decideProposal(
      { id: proposalId, workspaceId },
      "approved",
    );
    expect((await a.dashboard.getContext(workspaceId))?.goal).toBe(NEW_GOAL);

    const sync = await agent.ok<McpSync>("sync_workspace", {
      since: cursorBeforeProposal,
    });
    expect(sync.context.goal).toBe(NEW_GOAL);
    expect(sync.pending_proposals.map((p) => p.id)).not.toContain(proposalId);
    const seqs = sync.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(seqs.every((s, i) => i === 0 || s === seqs[i - 1]! + 1)).toBe(true);
    const about = sync.events.filter((e) => e.subject_id === proposalId);
    expect(about.map((e) => [e.type, e.actor.actor_type])).toEqual([
      ["context.proposed", "agent"],
      ["context.approved", "human"],
    ]);
    expect(sync.events_truncated).toBe(false);

    // Nothing new after that cursor.
    const again = await agent.ok<McpSync>("sync_workspace", {
      since: sync.cursor,
    });
    expect(again.events).toEqual([]);
    evidence.step7 = {
      proposalId,
      eventsSinceCursor: sync.events.map(
        (e) => `${e.seq}:${e.type}:${e.actor.actor_type}`,
      ),
    };
  });

  it("7-scope. agent proposes scope; human approves in dashboard; next MCP sync returns it", async () => {
    const before = await agent.ok<McpSync>("sync_workspace");
    const { proposal } = await agent.ok<{
      proposal: { id: string; status: string; field: string };
    }>("propose_context_change", {
      field: "scope",
      proposed_value: NEW_SCOPE,
      rationale: "Demo step 6: limit the shared workspace scope",
      source_ids: [fileId],
    });
    expect(proposal).toMatchObject({
      field: "scope",
      status: "pending",
      proposed_value: NEW_SCOPE,
      proposed_by: { actor_type: "agent", client: "claude" },
    });
    expect((await a.dashboard.getContext(workspaceId))?.scope).toBe(before.context.scope);
    await a.dashboard.decideProposal({ id: proposal.id, workspaceId }, "approved");

    // This is the first MCP sync after human approval, through the real endpoint.
    const sync = await agent.ok<McpSync>("sync_workspace", { since: before.cursor });
    expect(sync.context.scope).toBe(NEW_SCOPE);
    expect(sync.context.goal).toBe(NEW_GOAL);
    expect(sync.context_version).toBe(before.context_version + 1);
    expect(sync.pending_proposals.map((p) => p.id)).not.toContain(proposal.id);
    expect(sync.events.filter((e) => e.subject_id === proposal.id)
      .map((e) => [e.type, e.actor.actor_type])).toEqual([
      ["context.proposed", "agent"],
      ["context.approved", "human"],
    ]);
    evidence.step7Scope = {
      workspaceId, proposalId: proposal.id, scope: sync.context.scope,
      contextVersion: sync.context_version,
    };
  });

  it("7a. A publishes a finding and B's next cursor sync receives the full summary and files", async () => {
    const connection = await b.dashboard.createAgentConnection(workspaceId, {
      client: "chatgpt", displayName: "Blake's ChatGPT",
    });
    teammateConnectionId = connection.connectionId;
    const teammate = await Agent.connect(mcpUrl, connection.token);
    try {
      const before = await teammate.ok<McpSync>("sync_workspace");
      const summary = `Full finding (${run}): use expected_version when updating proposal.md; stale writes must reread and reconcile.`;
      const { published } = await agent.ok<{ published: McpSync["recent_work"][number] }>("publish_work", {
        kind: "finding", title: "Version conflict findings", summary, file_ids: [fileId],
      });
      const after = await teammate.ok<McpSync>("sync_workspace", { since: before.cursor });
      expect(after.recent_work).toEqual([published]);
      expect(after.recent_work[0]).toMatchObject({
        kind: "finding", title: "Version conflict findings", summary, file_ids: [fileId],
        published_by: { actor_type: "agent", agent_connection_id: connectionId },
        created_at: expect.any(String),
      });
      expect(after.work_truncated).toBe(false);
      expect((await teammate.ok<McpSync>("sync_workspace", { since: after.cursor })).recent_work).toEqual([]);

      // Use a separate document so the P0 file's revision assertions stay meaningful.
      const backlogFile = await agent.ok<McpFile>("create_document", { name: `backlog-${run}.md`, content: "" });
      const backlogStart = await teammate.ok<McpSync>("sync_workspace");
      for (let version = 1; version <= 50; version++) {
        await agent.ok("update_document", { file_id: backlogFile.id, expected_version: version, content: `Update ${version}` });
      }
      const backlogWork = (await agent.ok<{ published: McpSync["recent_work"][number] }>("publish_work", {
        kind: "deliverable", title: "After backlog", summary: "Full finding after 50 updates", file_ids: [backlogFile.id],
      })).published;
      const first = await teammate.ok<McpSync>("sync_workspace", { since: backlogStart.cursor });
      expect(first.events).toHaveLength(50);
      expect(first.events_truncated).toBe(true);
      expect(first.recent_work).toEqual([]);
      expect(first.work_truncated).toBe(false);
      const second = await teammate.ok<McpSync>("sync_workspace", { since: first.cursor });
      expect(second.events_truncated).toBe(false);
      expect(second.recent_work).toEqual([backlogWork]);
      const empty = await teammate.ok<McpSync>("sync_workspace", { since: second.cursor });
      expect(empty.events).toEqual([]);
      expect(empty.recent_work).toEqual([]);

      const works = [];
      for (let i = 0; i < 21; i++) {
        works.push((await agent.ok<{ published: McpSync["recent_work"][number] }>("publish_work", {
          kind: "finding", title: `Finding ${i}`, summary: `Full finding ${i}`, file_ids: [fileId],
        })).published);
      }
      const capped = await teammate.ok<McpSync>("sync_workspace", { since: second.cursor });
      expect(capped.recent_work).toEqual(works.slice(-20).reverse());
      expect(capped.work_truncated).toBe(true);
      const snapshot = await teammate.ok<McpSync>("sync_workspace");
      expect(snapshot.recent_work).toEqual(capped.recent_work);
      expect(snapshot.work_truncated).toBe(true);
    } finally {
      await teammate.close();
    }
  });

  it("7b. a goal proposal based on an older goal goes stale instead of overwriting the newer one", async () => {
    const propose = async (value: string) =>
      (
        await agent.ok<{ proposal: { id: string } }>("propose_context_change", {
          field: "goal",
          proposed_value: value,
          rationale: "Competing goal",
        })
      ).proposal.id;
    const first = await propose(`First competing goal (${run})`);
    const second = await propose(`Second competing goal (${run})`);
    await a.dashboard.decideProposal({ id: first, workspaceId }, "approved");
    // The backend marks the second stale (and keeps that record); the adapter surfaces VERSION_CONFLICT.
    expect(
      await dashboardCode(
        a.dashboard.decideProposal({ id: second, workspaceId }, "approved"),
      ),
    ).toBe("VERSION_CONFLICT");
    expect((await a.dashboard.getContext(workspaceId))?.goal).toBe(
      `First competing goal (${run})`,
    );
    expect(
      (await a.dashboard.listProposals(workspaceId, "stale")).map((p) => p.id),
    ).toContain(second);
    const fromAgent = await agent.ok<{
      proposals: { id: string; status: string }[];
    }>("get_approvals", {
      status: "stale",
    });
    expect(fromAgent.proposals.map((p) => [p.id, p.status])).toContainEqual([
      second,
      "stale",
    ]);
    // Deciding it again says it's already decided.
    expect(
      await dashboardCode(
        a.dashboard.decideProposal({ id: second, workspaceId }, "approved"),
      ),
    ).toBe("PROPOSAL_DECIDED");
    evidence.step7b = { approved: first, stale: second };
  });

  it("7c. an agent adds and resolves a working question immediately with retained history", async () => {
    // Manual approval is the default; this step covers the automatic mode.
    await a.dashboard.setContextApproval(workspaceId, "automatic");
    const before = await agent.ok<McpSync>("sync_workspace");
    const text = `Which native client should we demo first? (${run})`;
    const added = await agent.ok<{ proposal: { id: string; status: string } }>(
      "propose_context_change",
      {
        field: "open_questions",
        proposed_value: text,
        rationale: "Track demo planning",
        source_ids: [fileId],
      },
    );
    expect(added.proposal.status).toBe("applied");
    const active = await agent.ok<McpSync>("sync_workspace", {
      since: before.cursor,
    });
    const question = active.context.open_questions.find(
      (q) => q.text === text,
    )!;
    expect(question).toMatchObject({
      id: expect.any(String),
      status: "active",
      resolved_by: null,
      resolved_at: null,
    });
    expect(active.pending_proposals.map((p) => p.id)).not.toContain(
      added.proposal.id,
    );
    const resolve = {
      operation: "resolve",
      field: "open_questions",
      entry_id: question.id,
      rationale: "Claude is the primary target",
      source_ids: [fileId],
    };
    expect(
      (
        await agent.fails("propose_context_change", {
          ...resolve,
          expected_version: before.context_version,
        })
      ).code,
    ).toBe("VERSION_CONFLICT");
    const resolved = await agent.ok<{ proposal: { status: string } }>(
      "propose_context_change",
      { ...resolve, expected_version: active.context_version },
    );
    expect(resolved.proposal.status).toBe("applied");
    const after = await agent.ok<McpSync>("sync_workspace");
    expect(
      after.context.open_questions.find((q) => q.id === question.id),
    ).toMatchObject({
      status: "resolved",
      resolved_at: expect.any(Number),
      resolved_by: { actor_type: "agent", agent_connection_id: connectionId },
    });
    evidence.step7c = {
      added: added.proposal,
      questionId: question.id,
      resolved: after.context.open_questions.find((q) => q.id === question.id),
    };
    await a.dashboard.setContextApproval(workspaceId, "manual");
  });

  it("7d. a superseding decision stays pending until human approval and retains both IDs", async () => {
    const proposeDecision = async (text: string, supersedes?: string) =>
      (
        await agent.ok<{
          proposal: { id: string; status: string; supersedes: string | null };
        }>("propose_context_change", {
          field: "decisions",
          proposed_value: text,
          rationale: "Demo architecture",
          source_ids: [fileId],
          ...(supersedes ? { supersedes } : {}),
        })
      ).proposal;
    const originalText = `Demo Claude first (${run})`;
    const original = await proposeDecision(originalText);
    await a.dashboard.decideProposal(
      { id: original.id, workspaceId },
      "approved",
    );
    const before = await agent.ok<McpSync>("sync_workspace");
    const d1 = before.context.decisions.find((d) => d.text === originalText)!;
    expect(d1).toMatchObject({ id: expect.any(String), status: "active" });
    const replacement = await proposeDecision(
      `Demo Claude then ChatGPT (${run})`,
      d1.id,
    );
    expect(replacement).toMatchObject({ status: "pending", supersedes: d1.id });
    const pending = await agent.ok<McpSync>("sync_workspace");
    expect(pending.context.decisions.find((d) => d.id === d1.id)).toEqual(d1);
    expect(pending.pending_proposals).toContainEqual(
      expect.objectContaining({
        id: replacement.id,
        supersedes: d1.id,
        status: "pending",
      }),
    );
    await a.dashboard.decideProposal(
      { id: replacement.id, workspaceId },
      "approved",
    );
    const after = await agent.ok<McpSync>("sync_workspace");
    const old = after.context.decisions.find((d) => d.id === d1.id)!;
    const current = after.context.decisions.find(
      (d) => d.id === old.superseded_by,
    )!;
    expect(old.status).toBe("superseded");
    expect(current).toMatchObject({
      status: "active",
      text: `Demo Claude then ChatGPT (${run})`,
    });
    expect(after.pending_proposals.map((p) => p.id)).not.toContain(
      replacement.id,
    );
    evidence.step7d = { proposalId: replacement.id, old, current };
  });

  it("7e. resolves a dashboard-created question longer than 2000 characters without proposed_value", async () => {
    await a.dashboard.setContextApproval(workspaceId, "automatic");
    const before = await agent.ok<McpSync>("sync_workspace");
    const text = `Long dashboard question (${run}): ${"x".repeat(2100)}`;
    await a.http.mutation(api.context.updateContextField, {
      workspaceId: workspaceId as Id<"workspaces">,
      field: "open_question",
      proposedValue: text,
      expectedVersion: before.context_version,
      sourceFileIds: [fileId as Id<"files">],
    });
    const active = await agent.ok<McpSync>("sync_workspace");
    const question = active.context.open_questions.find((q) => q.text === text)!;
    expect(question).toMatchObject({ id: expect.any(String), status: "active" });
    const { proposal } = await agent.ok<{
      proposal: { status: string; proposed_value: string };
    }>("propose_context_change", {
      field: "open_questions",
      operation: "resolve",
      entry_id: question.id,
      expected_version: active.context_version,
      rationale: "Answered in the dashboard planning session",
    });
    expect(proposal).toMatchObject({ status: "applied", proposed_value: text });
    const after = await agent.ok<McpSync>("sync_workspace");
    expect(after.context.open_questions.find((q) => q.id === question.id)).toMatchObject({
      text,
      status: "resolved",
      resolved_by: { actor_type: "agent", agent_connection_id: connectionId },
      resolved_at: expect.any(Number),
    });
    evidence.step7e = { questionId: question.id, length: text.length, status: "resolved" };
    await a.dashboard.setContextApproval(workspaceId, "manual");
  });

  it("8. tenant boundaries: C's token and session can't touch A's workspace; revoked and malformed tokens get 401", async () => {
    // C's own assistant.
    const cConnection = await c.dashboard.createAgentConnection(cWorkspaceId, {
      client: "chatgpt",
    });
    const cAgent = await Agent.connect(mcpUrl, cConnection.token);
    try {
      expect((await cAgent.ok<McpSync>("sync_workspace")).recent_work).toEqual([]);
      const cFiles = await cAgent.ok<{ files: McpFile[] }>("list_files");
      expect(cFiles.files.map((f) => f.id)).not.toContain(fileId);
      expect(
        (await cAgent.fails("list_files", { workspace_id: workspaceId })).code,
      ).toBe("FORBIDDEN");
      expect(
        (await cAgent.fails("sync_workspace", { workspace_id: workspaceId }))
          .code,
      ).toBe("FORBIDDEN");
      expect(["FILE_NOT_FOUND", "FORBIDDEN"]).toContain(
        (await cAgent.fails("read_file", { file_id: fileId })).code,
      );
      expect(["FILE_NOT_FOUND", "FORBIDDEN"]).toContain(
        (
          await cAgent.fails("update_document", {
            file_id: fileId,
            content: "pwned",
            expected_version: 2,
          })
        ).code,
      );
      expect(["FILE_NOT_FOUND", "FORBIDDEN"]).toContain(
        (await cAgent.fails("get_file_versions", { file_id: fileId })).code,
      );
      const search = await cAgent.ok<unknown>("search_files", { query: run });
      expect(JSON.stringify(search)).not.toContain(fileId);
    } finally {
      await cAgent.close();
    }

    // C's dashboard session.
    expect(await dashboardCode(c.dashboard.listFiles(workspaceId))).toBe(
      "FORBIDDEN",
    );
    expect(["FILE_NOT_FOUND", "FORBIDDEN"]).toContain(
      await dashboardCode(c.dashboard.readFile(fileId)),
    );
    expect(["FILE_NOT_FOUND", "FORBIDDEN"]).toContain(
      await dashboardCode(
        c.dashboard.updateFileContent(fileId, {
          content: "pwned",
          expectedVersion: 2,
        }),
      ),
    );
    expect(await dashboardCode(c.dashboard.getContext(workspaceId))).toBe(
      "FORBIDDEN",
    );
    expect(
      await dashboardCode(c.dashboard.listAgentConnections(workspaceId)),
    ).toBe("FORBIDDEN");
    expect(
      await dashboardCode(c.dashboard.revokeAgentConnection(connectionId)),
    ).toBe("FORBIDDEN");
    expect(await b.dashboard.readFile(fileId)).toMatchObject({
      version: 2,
      content: V2,
    });

    // Revoked token: the connection stops working on the very next request.
    const doomed = await a.dashboard.createAgentConnection(workspaceId, {
      client: "gemini",
    });
    const doomedAgent = await Agent.connect(mcpUrl, doomed.token);
    await doomedAgent.ok("list_files");
    await a.dashboard.revokeAgentConnection(doomed.connectionId);
    await expect(doomedAgent.call("list_files")).rejects.toMatchObject({ code: 401 });
    await doomedAgent.close().catch(() => {});
    const revoked = await rawMcpStatus(mcpUrl, {
      Authorization: `Bearer ${doomed.token}`,
    });
    expect(revoked.status).toBe(401);
    expect(revoked.wwwAuthenticate).toMatch(/^Bearer/);
    await expect(Agent.connect(mcpUrl, doomed.token)).rejects.toThrow();
    const listed = await a.dashboard.listAgentConnections(workspaceId);
    expect(listed.find((x) => x.id === doomed.connectionId)?.revokedAt).toEqual(
      expect.any(Number),
    );

    // Malformed or forged credentials.
    const statuses = {
      none: (await rawMcpStatus(mcpUrl, {})).status,
      emptyBearer: (await rawMcpStatus(mcpUrl, { Authorization: "Bearer " })).status,
      notAKey: (await rawMcpStatus(mcpUrl, { Authorization: "Bearer not-a-token" })).status,
      forgedKey: (await rawMcpStatus(mcpUrl, { Authorization: `Bearer mcp_sk_${"A".repeat(43)}` })).status,
      humanJwt: (await rawMcpStatus(mcpUrl, { Authorization: `Bearer ${a.jwt}` })).status,
      basicScheme: (await rawMcpStatus(mcpUrl, { Authorization: `Basic ${token}` })).status,
    };
    expect(statuses).toEqual({
      none: 401,
      emptyBearer: 401,
      notAKey: 401,
      forgedKey: 401,
      humanJwt: 401,
      basicScheme: 401,
    });
    // Only Authorization: Bearer carries a credential; the old api-key header doesn't.
    expect((await rawMcpStatus(mcpUrl, { "api-key": token })).status).toBe(401);
    expect((await rawMcpStatus(mcpUrl, { Authorization: `Bearer ${token}` })).status).toBe(200);
    evidence.step8 = { revokedStatus: revoked.status, statuses };
  });

  it("9. presence: last MCP action and last sync are recorded, and nothing says online", async () => {
    const connections = await a.dashboard.listAgentConnections(workspaceId);
    const mine = connections.find((x) => x.id === connectionId);
    expect(mine).toMatchObject({
      client: "claude",
      displayName: "Avery's Claude",
      lastMcpActionAt: expect.any(Number),
      lastSyncAt: expect.any(Number),
    });
    expect(mine).not.toHaveProperty("revokedAt");
    // B (a member) sees only their own connections.
    expect(
      (await b.dashboard.listAgentConnections(workspaceId)).map((x) => x.id),
    ).toEqual([teammateConnectionId]);

    const info = await agent.ok<Record<string, unknown>>("get_workspace_info");
    expect(JSON.stringify(info)).not.toMatch(/online/i);
    // Members of A's workspace only (A and B, never C), by name, with no emails.
    const members = info.members as {
      user_id: string;
      name: string;
      role: string;
    }[];
    expect(members.map((m) => [m.name, m.role]).sort()).toEqual(
      [
        [a.name, "owner"],
        [b.name, "member"],
      ].sort(),
    );
    expect(members.map((m) => m.name)).not.toContain(c.name);
    expect(JSON.stringify(members)).not.toContain("@");
    expect(JSON.stringify(connections)).not.toMatch(/online/i);
    evidence.step9 = { connection: mine, workspaceInfo: info };
    evidence.browser = { b: { email: b.email, password }, workspaceId, fileId };
  });

  it("10. OAuth: a claude.ai-style client connects through consent, writes as A via Claude, and revoke gets 401", async () => {
    const site = new URL(mcpUrl).origin;
    const callback = "https://claude.ai/api/mcp/auth_callback";
    // Discovery, the way claude.ai finds the authorization server.
    const prm = (await (await fetch(`${site}/.well-known/oauth-protected-resource/mcp`)).json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(prm).toMatchObject({ resource: mcpUrl, authorization_servers: [site] });
    const asm = (await (await fetch(`${site}/.well-known/oauth-authorization-server`)).json()) as Record<string, string>;
    const registered = await fetch(asm.registration_endpoint!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude",
        redirect_uris: [callback],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    expect(registered.status).toBe(201);
    const { client_id: clientId } = (await registered.json()) as { client_id: string };

    const verifier = `${run}-${crypto.randomUUID()}-${crypto.randomUUID()}`;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const challenge = Buffer.from(digest).toString("base64url");
    const authorizeUrl = new URL(asm.authorization_endpoint!);
    for (const [k, v] of Object.entries({
      response_type: "code",
      client_id: clientId,
      redirect_uri: callback,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: run,
      resource: mcpUrl,
    }))
      authorizeUrl.searchParams.set(k, v);
    const authorize = await fetch(authorizeUrl, { redirect: "manual" });
    expect(authorize.status).toBe(302);
    const consentUrl = new URL(authorize.headers.get("location")!);
    expect(consentUrl.pathname).toBe("/oauth/consent");
    const requestId = consentUrl.searchParams.get("request")!;

    // A on the consent page: picks the workspace and the assistant, approves.
    const request = await a.dashboard.getConsentRequest(requestId);
    expect(request).toMatchObject({ status: "pending", clientName: "Claude", redirectHost: "claude.ai", suggestedClient: "claude" });
    expect(request?.workspaces.map((w) => w.id)).toContain(workspaceId);
    // C can't connect it to A's workspace.
    expect(
      await dashboardCode(c.dashboard.decideConsent(requestId, { approve: true, workspaceId, client: "claude" })),
    ).toBe("FORBIDDEN");
    const { redirectUrl } = await a.dashboard.decideConsent(requestId, { approve: true, workspaceId, client: "claude" });
    const back = new URL(redirectUrl);
    expect(`${back.origin}${back.pathname}`).toBe(callback);
    expect(back.searchParams.get("state")).toBe(run);
    expect(back.searchParams.get("iss")).toBe(site);

    const tokenRes = await fetch(asm.token_endpoint!, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: back.searchParams.get("code")!,
        redirect_uri: callback,
        client_id: clientId,
        code_verifier: verifier,
        resource: mcpUrl,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string; scope?: string };

    const claude = await Agent.connect(mcpUrl, tokens.access_token);
    const created = await claude.ok<McpFile>("create_document", { name: `oauth-${run}.md`, content: "from claude.ai" });
    expect(created.updated_by).toMatchObject({ actor_type: "agent", client: "claude" });
    const [revision] = await a.dashboard.listRevisions(created.id);
    expect(revision).toMatchObject({ actorType: "agent", agentClient: "claude", userName: a.name });
    const oauthConnection = (await a.dashboard.listAgentConnections(workspaceId)).find(
      (x) => x.authKind === "oauth" && x.revokedAt === undefined,
    );
    expect(oauthConnection).toMatchObject({ client: "claude", oauthClientName: "Claude", lastMcpActionAt: expect.any(Number) });

    await a.dashboard.revokeAgentConnection(oauthConnection!.id);
    expect((await rawMcpStatus(mcpUrl, { Authorization: `Bearer ${tokens.access_token}` })).status).toBe(401);
    const refresh = await fetch(asm.token_endpoint!, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }),
    });
    expect(refresh.status).toBe(400);
    await claude.close().catch(() => {});
    evidence.step10 = { clientId, connectionId: oauthConnection!.id, file: created };
  });

  it("11. folders: the agent makes /specs/api and a document in it; B's dashboard listing sees both", async () => {
    type McpFolder = { id: string; name: string; path: string };
    const made = await agent.ok<{ folder: McpFolder; created: boolean }>("create_folder", { path: "/specs/api" });
    expect(made).toMatchObject({ created: true, folder: { name: "api", path: "/specs/api" } });
    // mkdir -p is idempotent and paths are case-insensitive.
    const again = await agent.ok<{ folder: McpFolder; created: boolean }>("create_folder", { path: "/Specs/API/" });
    expect(again).toMatchObject({ created: false, folder: { id: made.folder.id } });
    const doc = await agent.ok<McpFile & { path: string }>("create_document", {
      name: "endpoints.md",
      content: "GET /",
      folder_path: "/specs/api",
    });
    expect(doc).toMatchObject({ path: "/specs/api/endpoints.md", version: 1 });

    const root = await b.dashboard.listDirectory(workspaceId);
    expect(root.folders.find((f) => f.name === "specs")).toMatchObject({ path: "/specs" });
    const listing = await b.dashboard.listDirectory(workspaceId, made.folder.id);
    expect(listing.breadcrumbs.map((crumb) => crumb.name)).toEqual(["specs", "api"]);
    expect(listing.files).toEqual([expect.objectContaining({ id: doc.id, name: "endpoints.md", version: 1 })]);
    expect((await agent.fails("list_files", { path: "//" })).code).toBe("INVALID_PATH");
    evidence.step11 = { folder: made.folder, file: doc };
  });
});
