import { describe, expect, it, vi } from "vitest";
import type { ConvexReactClient } from "convex/react";
import {
  getFunctionName,
  type FunctionReference,
  type FunctionReturnType,
} from "convex/server";
import { api } from "@repo/backend/convex/_generated/api.js";
import type { Id } from "@repo/backend/convex/_generated/dataModel.js";
import { createConvexApi, toContextDetails } from "@/lib/api/convex";
import { createMockApi, MOCK_WORKSPACE_ID } from "@/lib/api/mock";
import type { Actor, PublishedWork } from "@/lib/api/types";
import { contextSections, loadContextPage } from "@/lib/context";

const owner: Actor = { actorType: "human", userId: "owner", userName: "Owner" };
const member: Actor = {
  actorType: "human",
  userId: "member",
  userName: "Member",
};
const work = (
  title: string,
): Omit<PublishedWork, "workspaceId" | "id" | "createdAt"> => ({
  kind: "finding",
  title,
  summary: "A shared finding",
  fileIds: ["file_proposal"],
  createdBy: {
    actorType: "agent",
    userId: "owner",
    userName: "Owner",
    agentName: "Claude",
    agentClient: "claude",
  },
});
const setup = () => {
  let actor = owner;
  const mock = createMockApi({ latencyMs: [0, 0], getActor: () => actor });
  return {
    mock,
    as: (next: Actor) => {
      actor = next;
    },
  };
};

function fakeConvex(responses: Record<string, unknown>) {
  const calls: { name: string; args: unknown }[] = [];
  const run = async (
    reference: FunctionReference<"query" | "mutation">,
    args: unknown,
  ) => {
    const name = getFunctionName(reference);
    calls.push({ name, args });
    if (!(name in responses)) throw new Error(`Missing fixture ${name}`);
    return responses[name];
  };
  return {
    calls,
    client: { query: run, mutation: run } as unknown as ConvexReactClient,
  };
}

describe("project context mapping", () => {
  const userId = "users_owner" as Id<"users">;
  const source = "files_plan" as Id<"files">;
  const entry = {
    id: "entry_1", status: "active" as const, resolvedBy: null, resolvedAt: null, supersededBy: null,
    text: "Ship",
    sourceFileIds: [source],
    updatedBy: { type: "human" as const, label: "Owner", userId },
    updatedAt: 10,
  };
  const backend: FunctionReturnType<typeof api.context.getDetails> = {
    goal: null,
    scope: entry,
    constraints: [entry],
    decisions: [entry],
    ownership: [{ ...entry, ownerUserId: userId, ownerArea: "Build" }],
    openQuestions: [entry],
    revision: 7,
    updatedAt: 10,
    updatedBy: entry.updatedBy,
  };

  it("retains every field, per-entry sources and attribution even before a goal is set", () => {
    const details = toContextDetails(backend);
    expect(details.version).toBe(7);
    expect(
      contextSections(details).map((section) => [
        section.field,
        section.entries.length,
      ]),
    ).toEqual([
      ["goal", 0],
      ["scope", 1],
      ["constraint", 1],
      ["decision", 1],
      ["ownership", 1],
      ["open_question", 1],
    ]);
    expect(details.ownership[0]).toEqual({
      ...entry,
      updatedBy: { actorType: "human", userId, userName: "Owner" },
      ownerArea: "Build",
      ownerUserId: userId,
    });
    expect(details.scope?.sourceFileIds).toEqual([source]);
  });

  it("calls the new Convex methods with exact args and maps paginated actors", async () => {
    const change = {
      field: "ownership" as const,
      proposedValue: "Build",
      ownerUserId: userId,
      sourceFileIds: [source],
    };
    const backendWork = {
      id: "work_1",
      workspaceId: "ws",
      kind: "finding",
      title: "Finding",
      summary: "Result",
      fileIds: [source],
      createdBy: {
        type: "agent",
        label: "Claude",
        client: "claude",
        userName: "Owner",
        userId,
      },
      createdAt: 15,
    };
    const fake = fakeConvex({
      "context:getDetails": backend,
      "context:updateContextField": { version: 8 },
      "context:proposeContextChange": { id: "proposal_1", status: "pending" },
      "context:listPublishedWork": {
        page: [backendWork],
        isDone: false,
        continueCursor: "next",
      },
      "workspaces:getWorkspaceInfo": {
        members: [
          { userId, name: "Owner" },
          { userId: "u2", name: null },
        ],
      },
    });
    const adapter = createConvexApi(fake.client);
    expect(await adapter.getContextDetails("ws")).toEqual(
      toContextDetails(backend),
    );
    expect(
      await adapter.updateContextField("ws", {
        ...change,
        expectedVersion: 7,
        entryIndex: 0,
      }),
    ).toEqual({ version: 8 });
    expect(
      await adapter.proposeContextChange("ws", {
        ...change,
        rationale: "Owner agreed",
      }),
    ).toEqual({ id: "proposal_1", status: "pending" });
    expect(
      (await adapter.listPublishedWork("ws", "cursor", 2)).page[0]?.createdBy,
    ).toEqual({
      actorType: "agent",
      userId,
      userName: "Owner",
      agentName: "Claude",
      agentClient: "claude",
    });
    expect(await adapter.listWorkspaceMembers("ws")).toEqual([
      { userId, name: "Owner" },
      { userId: "u2", name: "Workspace member" },
    ]);
    expect(fake.calls).toEqual([
      { name: "context:getDetails", args: { workspaceId: "ws" } },
      {
        name: "context:updateContextField",
        args: {
          workspaceId: "ws",
          ...change,
          expectedVersion: 7,
          entryIndex: 0,
        },
      },
      {
        name: "context:proposeContextChange",
        args: { workspaceId: "ws", ...change, rationale: "Owner agreed" },
      },
      {
        name: "context:listPublishedWork",
        args: {
          workspaceId: "ws",
          paginationOpts: { cursor: "cursor", numItems: 2 },
        },
      },
      { name: "workspaces:getWorkspaceInfo", args: { workspaceId: "ws" } },
    ]);
    await adapter.proposeContextChange("ws", {
      field: "goal",
      proposedValue: "Ship",
      sourceFileIds: [],
      rationale: "Agreed",
    });
    expect(fake.calls.at(-1)?.args).not.toHaveProperty("ownerUserId");
  });
  it("forwards stable entry IDs, lifecycle operations, versions and superseding targets", async () => {
    const fake = fakeConvex({
      "context:updateContextField": { version: 8 },
      "context:proposeContextChange": { id: "proposal_2", status: "applied" },
    });
    const adapter = createConvexApi(fake.client);
    const input = { field: "open_question" as const, proposedValue: "When?", sourceFileIds: [], expectedVersion: 7, entryId: "backend-entry" };
    await adapter.updateContextField("ws", input);
    expect(fake.calls.at(-1)).toEqual({ name: "context:updateContextField", args: { workspaceId: "ws", ...input } });
    for (const operation of ["resolve", "remove"] as const) {
      const change = { ...input, operation, rationale: "Done" };
      expect(await adapter.proposeContextChange("ws", change)).toEqual({ id: "proposal_2", status: "applied" });
      expect(fake.calls.at(-1)).toEqual({ name: "context:proposeContextChange", args: { workspaceId: "ws", ...change } });
    }
    const replacement = { field: "decision" as const, proposedValue: "Use two clients", sourceFileIds: [], rationale: "Approved plan", supersedes: "decision-stable-id" };
    await adapter.proposeContextChange("ws", replacement);
    expect(fake.calls.at(-1)?.args).toEqual({ workspaceId: "ws", ...replacement });
  });

});

describe("mock project context parity", () => {
  it("supports versioned direct edits, source attribution, copies, and the approved-goal summary", async () => {
    const { mock } = setup();
    const before = await mock.getContextDetails(MOCK_WORKSPACE_ID);
    const input = {
      field: "goal" as const,
      proposedValue: "Ship today",
      sourceFileIds: ["file_brief"],
      expectedVersion: before.version,
    };
    expect(await mock.updateContextField(MOCK_WORKSPACE_ID, input)).toEqual({
      version: before.version + 1,
    });
    const after = await mock.getContextDetails(MOCK_WORKSPACE_ID);
    expect(after.goal).toMatchObject({
      text: "Ship today",
      sourceFileIds: ["file_brief"],
      updatedBy: owner,
    });
    expect((await mock.getContext(MOCK_WORKSPACE_ID))?.goal).toBe("Ship today");
    await expect(
      mock.updateContextField(MOCK_WORKSPACE_ID, input),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    after.goal!.sourceFileIds.push("bad");
    after.goal!.updatedBy.userName = "Changed";
    expect(
      (await mock.getContextDetails(MOCK_WORKSPACE_ID)).goal?.updatedBy,
    ).toEqual(owner);
    expect(
      (await mock.getContextDetails(MOCK_WORKSPACE_ID)).goal?.sourceFileIds,
    ).toEqual(["file_brief"]);
  });

  it.each(["member", "admin"] as const)(
    "enforces %s permissions and routes member proposals to approvals",
    async (role) => {
      const { mock, as } = setup();
      await mock.listWorkspaces();
      const invite = await mock.createInvite(MOCK_WORKSPACE_ID, role);
      as(member);
      await mock.acceptInvite(invite.token);
      const before = await mock.getContextDetails(MOCK_WORKSPACE_ID);
      const change = {
        field: "goal" as const,
        proposedValue: "A proposal",
        sourceFileIds: [],
      };
      if (role === "member") {
        await expect(
          mock.updateContextField(MOCK_WORKSPACE_ID, {
            ...change,
            expectedVersion: before.version,
          }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        const { id } = await mock.proposeContextChange(MOCK_WORKSPACE_ID, {
          ...change,
          rationale: "Team agreed",
        });
        expect(
          (await mock.listProposals(MOCK_WORKSPACE_ID, "pending")).find(
            (p) => p.id === id,
          ),
        ).toMatchObject({ proposedValue: "A proposal", createdBy: member });
        expect((await mock.getContextDetails(MOCK_WORKSPACE_ID)).version).toBe(
          before.version,
        );
        as(owner);
        await mock.decideProposal(
          { id, workspaceId: MOCK_WORKSPACE_ID },
          "approved",
        );
      } else
        await mock.updateContextField(MOCK_WORKSPACE_ID, {
          ...change,
          expectedVersion: before.version,
        });
      expect((await mock.getContextDetails(MOCK_WORKSPACE_ID)).goal?.text).toBe(
        "A proposal",
      );
    },
  );

  it("supports ownership and open questions, positional edits and source validation", async () => {
    const { mock } = setup();
    await mock.listWorkspaceMembers(MOCK_WORKSPACE_ID);
    let version = (await mock.getContextDetails(MOCK_WORKSPACE_ID)).version;
    for (const field of ["ownership", "open_question"] as const)
      await mock.updateContextField(MOCK_WORKSPACE_ID, {
        field,
        proposedValue: "Build",
        sourceFileIds: [],
        expectedVersion: version++,
        ...(field === "ownership" ? { ownerUserId: owner.userId } : {}),
      });
    await mock.updateContextField(MOCK_WORKSPACE_ID, {
      field: "open_question",
      proposedValue: "When?",
      sourceFileIds: [],
      expectedVersion: version++,
      entryIndex: 0,
    });
    const details = await mock.getContextDetails(MOCK_WORKSPACE_ID);
    expect(details.openQuestions.map((e) => e.text)).toEqual(["When?"]);
    expect(details.ownership[0]).toMatchObject({
      text: "Build: Owner",
      ownerUserId: owner.userId,
    });
    await expect(
      mock.updateContextField(MOCK_WORKSPACE_ID, {
        field: "goal",
        proposedValue: "Goal",
        sourceFileIds: ["missing"],
        expectedVersion: version,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects agents and outsiders and supports a new workspace without a goal", async () => {
    const { mock, as } = setup();
    await mock.listWorkspaces();
    const id = await mock.createWorkspace("Empty");
    expect((await mock.getContextDetails(id)).goal).toBeNull();
    as({ ...owner, actorType: "agent" });
    await expect(
      mock.updateContextField(id, {
        field: "goal",
        proposedValue: "Agent",
        sourceFileIds: [],
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    as({ ...member, userId: "outsider" });
    await expect(mock.getContextDetails(id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(mock.listPublishedWork(id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("paginates the feed and refreshes visible pages after a publication event", async () => {
    const { mock } = setup();
    let changed = 0;
    const stop = mock.watchWorkspace(MOCK_WORKSPACE_ID, () => changed++);
    for (let i = 0; i < 22; i++)
      mock.__simulatePublishedWork(MOCK_WORKSPACE_ID, work(`Finding ${i}`));
    await Promise.resolve();
    expect(changed).toBe(22);
    const first = await mock.listPublishedWork(MOCK_WORKSPACE_ID, null, 2);
    const next = await mock.listPublishedWork(
      MOCK_WORKSPACE_ID,
      first.continueCursor,
      2,
    );
    expect(first.page.map((w) => w.title)).toEqual([
      "Finding 21",
      "Finding 20",
    ]);
    expect(next.page.map((w) => w.title)).toEqual(["Finding 19", "Finding 18"]);
    const loaded = await loadContextPage(mock, MOCK_WORKSPACE_ID, 2);
    expect(loaded.work).toHaveLength(23);
    expect(loaded.hasMore).toBe(false);
    expect(loaded.files.some((f) => f.id === loaded.work[0]?.fileIds[0])).toBe(
      true,
    );
    mock.__simulatePublishedWork(MOCK_WORKSPACE_ID, work("New finding"));
    const refreshed = await loadContextPage(mock, MOCK_WORKSPACE_ID, 2);
    expect(refreshed.work[0]?.title).toBe("New finding");
    expect(refreshed.work).toHaveLength(24);
    first.page[0]!.createdBy.userName = "Changed";
    expect(
      (await mock.listPublishedWork(MOCK_WORKSPACE_ID)).page[0]?.createdBy
        .userName,
    ).toBe("Owner");
    stop();
    await Promise.resolve();
    const count = changed;
    mock.__simulatePublishedWork(MOCK_WORKSPACE_ID, work("Later"));
    await Promise.resolve();
    expect(changed).toBe(count);
    await expect(
      mock.listPublishedWork(MOCK_WORKSPACE_ID, null, 101),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("notifies watchers for human edits and proposals", async () => {
    const { mock } = setup();
    const onChange = vi.fn();
    mock.watchWorkspace(MOCK_WORKSPACE_ID, onChange);
    const { version } = await mock.getContextDetails(MOCK_WORKSPACE_ID);
    const change = {
      field: "scope" as const,
      proposedValue: "Scope",
      sourceFileIds: [],
    };
    await mock.updateContextField(MOCK_WORKSPACE_ID, {
      ...change,
      expectedVersion: version,
    });
    await mock.proposeContextChange(MOCK_WORKSPACE_ID, {
      ...change,
      rationale: "Because",
    });
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
