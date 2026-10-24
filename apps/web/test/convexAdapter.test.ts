import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import type { ConvexReactClient } from "convex/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { createConvexApi, REVISION_LIMIT } from "@/lib/api/convex";
import {
  type BackendActor,
  type BackendFile,
  type BackendRevision,
  type BackendWorkspaceContext,
  SYSTEM_USER_ID,
  toActor,
  toFileDetail,
  toProjectContext,
  toRevisions,
} from "@/lib/api/convexMappers";
import { normalizeError } from "@/lib/api/errors";
import { performSave } from "@/lib/editor/performSave";

// Fixtures are hand-copied from the validators in packages/backend/convex/*.ts
// on codex/backend-convex-vultr. They are typed against convexMappers.ts's own
// copies, not the backend's generated types, so a backend shape change will NOT
// fail these tests: re-check the fixtures when the backend changes.
const ALEX: BackendActor = { type: "human", userId: "users_alex", label: "Alex" };
const CLAUDE: BackendActor = {
  type: "agent",
  userId: "users_alex",
  agentConnectionId: "agent_connections_1",
  label: "Claude",
};

const FILE: BackendFile = {
  id: "files_1",
  workspaceId: "workspaces_1",
  parentId: null,
  name: "plan.md",
  mimeType: "text/markdown",
  version: 3,
  updatedAt: 1_700_000_000_000,
  updatedBy: CLAUDE,
};

const entry = (text: string, updatedAt = 1_700_000_000_000) => ({ text, sourceFileIds: [], updatedAt });

const EMPTY_CONTEXT: BackendWorkspaceContext = {
  goal: null,
  scope: null,
  constraints: [],
  decisions: [],
  ownership: [],
  openQuestions: [],
  revision: 1,
  updatedAt: 1_700_000_000_000,
};

describe("toActor", () => {
  it("maps a human's label to userName", () => {
    expect(toActor(ALEX)).toEqual({ actorType: "human", userId: "users_alex", userName: "Alex" });
  });

  it("maps an agent's label to agentName and its connection to agentClient", () => {
    expect(toActor(CLAUDE)).toEqual({
      actorType: "agent",
      userId: "users_alex",
      agentName: "Claude",
      agentClient: "agent_connections_1",
    });
  });

  it("keeps an agent without a connection id, and a missing userId as empty", () => {
    expect(toActor({ type: "agent", label: "Claude" })).toEqual({
      actorType: "agent",
      userId: "",
      agentName: "Claude",
    });
    expect(toActor({ type: "human", label: "Alex" })).toEqual({ actorType: "human", userId: "", userName: "Alex" });
  });

  it("renders a system actor by its label, not as an agent", () => {
    expect(toActor({ type: "system", label: "Tandem" })).toEqual({
      actorType: "human",
      userId: SYSTEM_USER_ID,
      userName: "Tandem",
    });
  });
});

describe("toFileDetail", () => {
  it("unwraps { file, content } and marks member-readable files editable", () => {
    expect(toFileDetail({ file: FILE, content: "# plan" })).toEqual({
      id: "files_1",
      workspaceId: "workspaces_1",
      parentId: null,
      name: "plan.md",
      mimeType: "text/markdown",
      version: 3,
      updatedAt: 1_700_000_000_000,
      updatedBy: toActor(CLAUDE),
      content: "# plan",
      permissions: { canEdit: true },
    });
  });

  it("keeps null content for binaries", () => {
    expect(toFileDetail({ file: FILE, content: null }).content).toBeNull();
  });
});

describe("toRevisions", () => {
  it("flattens the actor into each revision and orders newest first", () => {
    const revisions: BackendRevision[] = [
      { id: "r1", version: 1, content: "a", actor: ALEX, createdAt: 1 },
      { id: "r3", version: 3, content: "c", actor: CLAUDE, createdAt: 3 },
      { id: "r2", version: 2, content: "b", actor: ALEX, createdAt: 2 },
    ];
    const out = toRevisions(revisions);
    expect(out.map((r) => r.version)).toEqual([3, 2, 1]);
    expect(out[0]).toEqual({ ...toActor(CLAUDE), version: 3, createdAt: 3, content: "c" });
  });
});

describe("toProjectContext", () => {
  it("is null when there's no context row or no approved goal yet", () => {
    expect(toProjectContext(null)).toBeNull();
    expect(toProjectContext(EMPTY_CONTEXT)).toBeNull();
  });

  it("flattens entries to text and dates the approval from the goal", () => {
    const ctx = toProjectContext({
      ...EMPTY_CONTEXT,
      goal: entry("Ship the demo", 5),
      scope: entry("Dashboard + MCP"),
      constraints: [entry("No CRDT")],
      decisions: [entry("Use Convex")],
      revision: 4,
      updatedAt: 9,
    });
    expect(ctx).toMatchObject({
      goal: "Ship the demo",
      scope: "Dashboard + MCP",
      constraints: ["No CRDT"],
      decisions: ["Use Convex"],
      version: 4,
      approvedAt: 5,
    });
    // Backend doesn't send who approved: an anonymous human, not a guess.
    expect(ctx?.approvedBy).toEqual({ actorType: "human", userId: "" });
  });

  it("treats a missing scope as empty", () => {
    expect(toProjectContext({ ...EMPTY_CONTEXT, goal: entry("g") })?.scope).toBe("");
  });
});

/** A ConvexReactClient stand-in that answers by function name and records calls. */
function fakeConvex(responses: Record<string, unknown>) {
  const calls: { name: string; args: unknown }[] = [];
  const run = async (ref: FunctionReference<"query" | "mutation">, args: unknown) => {
    const name = getFunctionName(ref);
    calls.push({ name, args });
    const res = responses[name];
    if (res instanceof Error) throw res;
    if (res === undefined) throw new Error(`no fixture for ${name}`);
    return res;
  };
  const client = { query: run, mutation: run } as unknown as ConvexReactClient;
  return { client, calls };
}

describe("createConvexApi", () => {
  it("calls the backend's real function names and maps what comes back", async () => {
    const { client, calls } = fakeConvex({
      "workspaces:listWorkspaces": [{ id: "workspaces_1", name: "Cal Hacks", role: "owner", updatedAt: 1 }],
      "files:listFiles": [FILE],
      "files:readFile": { file: FILE, content: "x" },
      "files:createDocument": { ...FILE, id: "files_2", version: 1 },
      "files:updateDocument": { ...FILE, version: 4 },
      "files:getFileVersions": [{ id: "r1", version: 1, content: "a", actor: ALEX, createdAt: 1 }],
      "workspaces:getWorkspaceContext": { ...EMPTY_CONTEXT, goal: entry("Ship it") },
    });
    const api = createConvexApi(client);

    expect(await api.listWorkspaces()).toEqual([{ id: "workspaces_1", name: "Cal Hacks" }]);
    expect((await api.listFiles("workspaces_1"))[0]?.updatedBy.agentName).toBe("Claude");
    expect((await api.readFile("files_1")).content).toBe("x");
    expect(
      await api.createFile("workspaces_1", { name: "n.md", mimeType: "text/markdown", content: "" }),
    ).toEqual({ id: "files_2", version: 1 });
    expect(await api.updateFileContent("files_1", { expectedVersion: 3, content: "y" })).toEqual({
      version: 4,
    });
    expect((await api.listRevisions("files_1"))[0]?.userName).toBe("Alex");
    expect((await api.getContext("workspaces_1"))?.goal).toBe("Ship it");

    // Exact args: Convex rejects unknown keys, so an extra one would fail for real.
    expect(calls).toEqual([
      { name: "workspaces:listWorkspaces", args: {} },
      { name: "files:listFiles", args: { workspaceId: "workspaces_1" } },
      { name: "files:readFile", args: { fileId: "files_1" } },
      {
        name: "files:createDocument",
        args: { workspaceId: "workspaces_1", name: "n.md", mimeType: "text/markdown", content: "" },
      },
      { name: "files:updateDocument", args: { fileId: "files_1", expectedVersion: 3, content: "y" } },
      { name: "files:getFileVersions", args: { fileId: "files_1", limit: REVISION_LIMIT } },
      { name: "workspaces:getWorkspaceContext", args: { workspaceId: "workspaces_1" } },
    ]);
  });

  it("asks for the backend's maximum history, not its default of 20", () => {
    expect(REVISION_LIMIT).toBe(100);
  });

  it("turns the backend's plain VERSION_CONFLICT into a conflict, then refetches theirs", async () => {
    // What `convex dev` relays for the backend's `throw new Error("VERSION_CONFLICT: …")`.
    const conflict = new Error(
      "[CONVEX M(files:updateDocument)] [Request ID: abc] Server Error\n" +
        "Uncaught Error: VERSION_CONFLICT: current version is 4; expected 3\n    at handler (../convex/files.ts:180:13)",
    );
    const { client } = fakeConvex({
      "files:updateDocument": conflict,
      "files:readFile": { file: { ...FILE, version: 4 }, content: "# theirs" },
    });

    const err = await createConvexApi(client)
      .updateFileContent("files_1", { expectedVersion: 3, content: "# mine" })
      .catch((e: unknown) => e);
    expect(normalizeError(err)).toMatchObject({ code: "VERSION_CONFLICT", details: { currentVersion: 4 } });

    const event = await performSave(createConvexApi(client), "files_1", 3, "# mine");
    expect(event).toEqual({
      type: "SAVE_CONFLICT",
      theirs: { version: 4, content: "# theirs", updatedBy: toActor(CLAUDE) },
    });
  });

  it("recovers a conflict hidden by production's redacted message by rereading", async () => {
    // Deployed Convex redacts plain Errors to "Server Error", so this arrives as UNKNOWN.
    const redacted = new Error("[CONVEX M(files:updateDocument)] [Request ID: abc] Server Error\n  Called by client");
    expect(normalizeError(redacted).code).toBe("UNKNOWN");
    const { client } = fakeConvex({
      "files:updateDocument": redacted,
      "files:readFile": { file: { ...FILE, version: 4 }, content: "# theirs" },
    });
    expect(await performSave(createConvexApi(client), "files_1", 3, "# mine")).toMatchObject({
      type: "SAVE_CONFLICT",
      theirs: { version: 4, content: "# theirs" },
    });
  });

  it("keeps an UNKNOWN save error when the head hasn't moved or the reread fails", async () => {
    const redacted = new Error("[CONVEX M(files:updateDocument)] Server Error");
    const unchanged = fakeConvex({ "files:updateDocument": redacted, "files:readFile": { file: FILE, content: "x" } });
    expect(await performSave(createConvexApi(unchanged.client), "files_1", 3, "y")).toEqual({
      type: "SAVE_ERROR",
      code: "UNKNOWN",
    });
    const offline = fakeConvex({ "files:updateDocument": redacted, "files:readFile": new Error("Failed to fetch") });
    expect(await performSave(createConvexApi(offline.client), "files_1", 3, "y")).toEqual({
      type: "SAVE_ERROR",
      code: "UNKNOWN",
    });
  });
});

describe("backend errors", () => {
  const devError = (line: string) =>
    new Error(`[CONVEX M(files:x)] [Request ID: abc] Server Error\n${line}\n    at handler (../convex/files.ts:1:1)`);

  it.each([
    ["FORBIDDEN", "FORBIDDEN"],
    ["FILE_NOT_FOUND", "FILE_NOT_FOUND"],
    ["UNAUTHENTICATED", "UNAUTHENTICATED"],
    ["INVALID_NAME", "INVALID_INPUT"],
    ["INVALID_PARENT_FOLDER", "INVALID_INPUT"],
    ["INVALID_SOURCE_FILE", "INVALID_INPUT"],
    ["WORKSPACE_NOT_FOUND", "FILE_NOT_FOUND"],
    ["PROPOSAL_ALREADY_DECIDED", "VERSION_CONFLICT"],
  ])("maps the backend's plain %s to %s in dev", (thrown, code) => {
    expect(normalizeError(devError(`Uncaught Error: ${thrown}`)).code).toBe(code);
  });

  it("maps a conflict without a version, leaving currentVersion unset", () => {
    const err = normalizeError(devError("Uncaught Error: VERSION_CONFLICT"));
    expect(err.code).toBe("VERSION_CONFLICT");
    expect(err.details.currentVersion).toBeUndefined();
  });

  it("leaves server faults the dashboard has no copy for as UNKNOWN", () => {
    expect(normalizeError(devError("Uncaught Error: CONTEXT_NOT_INITIALIZED")).code).toBe("UNKNOWN");
  });

  it("only matches a whole 'Uncaught Error: CODE' line", () => {
    expect(normalizeError(devError("Uncaught Error: Something about FORBIDDEN")).code).toBe("UNKNOWN");
    expect(normalizeError(devError("note: Uncaught Error: FORBIDDEN")).code).toBe("UNKNOWN");
    expect(normalizeError(devError("Uncaught Error: FORBIDDEN_ISH thing")).code).toBe("UNKNOWN");
  });

  it("reads a ConvexError that uses the backend's own codes and actor shape", () => {
    const err = normalizeError(
      new ConvexError({
        code: "VERSION_CONFLICT",
        currentVersion: 4,
        currentContent: "# theirs",
        // CLAUDE spelled out: ConvexError data must be a plain Value, which an interface isn't.
        updatedBy: { type: "agent", userId: "users_alex", agentConnectionId: "agent_connections_1", label: "Claude" },
      }),
    );
    expect(err.code).toBe("VERSION_CONFLICT");
    expect(err.details).toMatchObject({ currentVersion: 4, currentContent: "# theirs", updatedBy: toActor(CLAUDE) });
    expect(normalizeError(new ConvexError({ code: "INVALID_NAME" })).code).toBe("INVALID_INPUT");
    expect(normalizeError(new ConvexError("WORKSPACE_NOT_FOUND")).code).toBe("FILE_NOT_FOUND");
  });
});
