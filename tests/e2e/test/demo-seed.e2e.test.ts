// Issue #22: the P0 slice on the seeded demo, as the demo itself runs it.
// Resets the demo (packages/backend/scripts/demo-reset.mjs), then Alex's
// Claude creates proposal.md v1, Blake saves v2 in the dashboard, the agent
// reads v2, a stale v1 update is rejected and history names both editors.
// Resets again at the end so the deployment is left clean for the demo.
//
// Opt-in, because it rotates the demo password and tokens unless DEMO_PASSWORD
// and DEMO_TOKEN_* are set: E2E_DEMO=1 pnpm test:demo
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, inject, it } from "vitest";
import { Agent } from "../src/agent";
import { signIn, type Human } from "../src/humans";

const convexUrl = inject("convexUrl");
const mcpUrl = inject("mcpUrl");
const resetScript = fileURLToPath(
  new URL("../../../packages/backend/scripts/demo-reset.mjs", import.meta.url),
);

interface Demo {
  workspaceId: string;
  workspaceName: string;
  briefFileId: string;
  password: string;
  members: {
    key: "alex" | "blake" | "casey";
    name: string;
    email: string;
    role: string;
    userId: string;
    client: string;
    connectionId: string;
    token: string;
  }[];
}

function resetDemo(): Demo {
  return JSON.parse(execFileSync("node", [resetScript, "--json"], { encoding: "utf8" }));
}

type Attribution = { actor_type: string; user_id: string; client: string; agent_connection_id?: string };
type McpFile = { id: string; name: string; version: number; updated_by: Attribution };

describe.runIf(process.env.E2E_DEMO)("demo seed: P0 slice on the seeded workspace", () => {
  let demo: Demo;
  let alex: Demo["members"][number];
  let blake: Human;
  let agent: Agent;
  let fileId: string;
  const V2 = "# Proposal\n\nMilestones and owners, edited by Blake in the dashboard.\n";

  afterAll(async () => {
    await agent?.close();
    await blake?.close();
  });

  it("1. reset gives one workspace: brief.md v1 by Alex, approved goal and scope, three members", async () => {
    demo = resetDemo();
    alex = demo.members.find((m) => m.key === "alex")!;
    expect(demo.members.map((m) => [m.key, m.role])).toEqual([
      ["alex", "owner"],
      ["blake", "member"],
      ["casey", "member"],
    ]);

    agent = await Agent.connect(mcpUrl, alex.token);
    const sync = await agent.ok<{
      workspace: { id: string };
      context: { goal: string; scope: string };
      pending_proposals: unknown[];
    }>("sync_workspace");
    expect(sync.workspace.id).toBe(demo.workspaceId);
    expect(sync.context.goal).toBeTruthy();
    expect(sync.context.scope).toBeTruthy();
    expect(sync.pending_proposals).toEqual([]);

    const { files } = await agent.ok<{ files: McpFile[] }>("list_files");
    expect(files.map((f) => f.name)).toEqual(["brief.md"]);
    const brief = await agent.ok<{ file: McpFile; content: string }>("read_file", {
      file_id: demo.briefFileId,
    });
    expect(brief.file).toMatchObject({ version: 1, updated_by: { actor_type: "human", user_id: alex.userId } });
    // The approved goal is the one in the brief it came from.
    expect(brief.content).toContain(sync.context.goal);
  });

  it("2. Alex's Claude creates proposal.md v1", async () => {
    const file = await agent.ok<McpFile>("create_document", {
      name: "proposal.md",
      content: "# Proposal\n\nDrafted by Alex's Claude from brief.md.\n",
    });
    expect(file).toMatchObject({ name: "proposal.md", version: 1 });
    expect(file.updated_by).toMatchObject({
      actor_type: "agent",
      user_id: alex.userId,
      client: "claude",
      agent_connection_id: alex.connectionId,
    });
    fileId = file.id;
  });

  it("3. Blake signs in with the seeded password and saves v2 in the dashboard", async () => {
    const member = demo.members.find((m) => m.key === "blake")!;
    blake = await signIn(convexUrl, { ...member, password: demo.password });
    expect(await blake.dashboard.listWorkspaces()).toContainEqual({
      id: demo.workspaceId,
      name: demo.workspaceName,
      role: "member",
    });
    const listed = (await blake.dashboard.listFiles(demo.workspaceId)).find((f) => f.id === fileId);
    expect(listed).toMatchObject({ version: 1, updatedBy: { actorType: "agent", userName: "Alex" } });
    expect(await blake.dashboard.updateFileContent(fileId, { content: V2, expectedVersion: 1 })).toEqual({
      version: 2,
    });
  });

  it("4. the agent reads v2; a stale v1 update is VERSION_CONFLICT", async () => {
    const read = await agent.ok<{ file: McpFile; content: string }>("read_file", { file_id: fileId });
    expect(read).toMatchObject({ file: { version: 2 }, content: V2 });
    const conflict = await agent.fails("update_document", {
      file_id: fileId,
      content: "stale overwrite",
      expected_version: 1,
    });
    expect(conflict).toMatchObject({ code: "VERSION_CONFLICT", current_version: 2, expected_version: 1 });
  });

  it("5. history names Alex's Claude for v1 and Blake for v2", async () => {
    const revisions = await blake.dashboard.listRevisions(fileId);
    expect(revisions.find((r) => r.version === 1)).toMatchObject({
      actorType: "agent",
      userName: "Alex",
      agentClient: "claude",
    });
    expect(revisions.find((r) => r.version === 2)).toMatchObject({ actorType: "human", userName: "Blake" });
  });

  it("6. a second reset leaves a clean demo: proposal.md gone, brief.md v1 only", async () => {
    await agent.close();
    demo = resetDemo();
    alex = demo.members.find((m) => m.key === "alex")!;
    agent = await Agent.connect(mcpUrl, alex.token);
    const { files } = await agent.ok<{ files: McpFile[] }>("list_files");
    expect(files.map((f) => [f.name, f.version])).toEqual([["brief.md", 1]]);
    // What the presenters need next; stable when DEMO_PASSWORD/DEMO_TOKEN_* are set.
    console.log(
      [
        `Demo workspace ${demo.workspaceId}, password ${demo.password}`,
        ...demo.members.map((m) => `${m.email} ${m.client} token ${m.token}`),
      ].join("\n"),
    );
  });
});
