import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevTokenResolver, withDevAnon } from "../src/auth.js";
import { MockBackend } from "../src/backend/mock.js";
import type { Actor } from "../src/backend/types.js";
import { createApp } from "../src/server.js";

const DEV_TOKENS =
  "alex-token:user_alex,sam-token:user_sam,jordan-token:user_jordan";

let server: Server;
let mcpUrl: URL;
let baseUrl: string;

async function listen(app: Server): Promise<string> {
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const { port } = app.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function stop(app: Server): Promise<void> {
  app.closeAllConnections();
  await new Promise((resolve) => app.close(resolve));
}

beforeAll(async () => {
  server = createApp({
    backend: new MockBackend(),
    identity: new DevTokenResolver(DEV_TOKENS),
  });
  baseUrl = await listen(server);
  mcpUrl = new URL("/mcp", baseUrl);
});

afterAll(() => stop(server));

/** Pass null to connect without an api-key header. */
async function connect(apiKey: string | null, url = mcpUrl): Promise<Client> {
  const client = new Client({ name: "test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: apiKey === null ? {} : { "api-key": apiKey },
    },
  });
  await client.connect(transport);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
) {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

/** Raw POST to /mcp with the given headers, for checking auth rejections. */
function post(url: URL, headers: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: "{}",
  });
}

function errorCode(result: CallToolResult): unknown {
  return (result.structuredContent as { error?: { code?: string } } | undefined)
    ?.error?.code;
}

describe("Tandem MCP server", () => {
  it("serves /healthz", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects /mcp requests without a valid api-key header", async () => {
    const cases: Record<string, string>[] = [
      {},
      { "api-key": "nope" },
      { "api-key": "" },
    ];
    for (const headers of cases) {
      const res = await post(mcpUrl, headers);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBeNull();
      expect(await res.json()).toEqual({
        error: {
          code: "UNAUTHENTICATED",
          message: "Missing or invalid api-key header.",
        },
      });
    }
  });

  it("ignores the Authorization header", async () => {
    const res = await post(mcpUrl, { Authorization: "Bearer alex-token" });
    expect(res.status).toBe(401);
  });

  it("accepts a valid api-key", async () => {
    const client = await connect("alex-token");
    const created = await call(client, "create_document", {
      name: "key.md",
      content: "x",
    });
    expect(created.structuredContent).toMatchObject({
      updated_by: { user_id: "user_alex", client: "dev-token" },
    });
    await client.close();
  });

  it("lists exactly the eleven tools", async () => {
    const client = await connect("alex-token");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "create_document",
      "get_approvals",
      "get_file_versions",
      "get_workspace_info",
      "list_files",
      "propose_context_change",
      "publish_work",
      "read_file",
      "search_files",
      "sync_workspace",
      "update_document",
    ]);
    await client.close();
  });

  it("annotates tools as non-destructive and closed-world", async () => {
    const client = await connect("alex-token");
    const { tools } = await client.listTools();
    const annotations = Object.fromEntries(
      tools.map((t) => [t.name, t.annotations]),
    );
    const readOnly = { readOnlyHint: true, openWorldHint: false };
    const write = {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    };
    const idempotentWrite = { ...write, idempotentHint: true };
    expect(annotations).toEqual({
      get_workspace_info: readOnly,
      list_files: readOnly,
      search_files: readOnly,
      read_file: readOnly,
      get_file_versions: readOnly,
      get_approvals: readOnly,
      sync_workspace: idempotentWrite,
      create_document: write,
      update_document: idempotentWrite,
      propose_context_change: write,
      publish_work: write,
    });
    await client.close();
  });

  it("lists the seeded brief in the default workspace", async () => {
    const client = await connect("sam-token");
    const result = await call(client, "list_files", {});
    const { files } = result.structuredContent as {
      files: { name: string; workspace_id: string }[];
    };
    expect(files).toContainEqual(
      expect.objectContaining({ name: "brief.md", workspace_id: "ws_demo" }),
    );
    await client.close();
  });

  it("creates, reads, updates, and rejects stale writes", async () => {
    const alex = await connect("alex-token");
    const sam = await connect("sam-token");

    const created = await call(alex, "create_document", {
      name: "plan.md",
      content: "v1 content",
    });
    expect(created.isError).toBeFalsy();
    const file = created.structuredContent as {
      id: string;
      version: number;
      mime_type: string;
      updated_by: unknown;
    };
    expect(file.version).toBe(1);
    expect(file.mime_type).toBe("text/markdown");
    expect(file.updated_by).toEqual({
      actor_type: "agent",
      user_id: "user_alex",
      client: "dev-token",
    });
    expect(JSON.parse((created.content[0] as { text: string }).text)).toEqual(
      file,
    );

    const read = await call(sam, "read_file", { file_id: file.id });
    expect(read.structuredContent).toMatchObject({
      file: { id: file.id, version: 1 },
      content: "v1 content",
    });

    const updated = await call(sam, "update_document", {
      file_id: file.id,
      content: "v2 content",
      expected_version: 1,
    });
    expect(updated.isError).toBeFalsy();
    expect(updated.structuredContent).toMatchObject({
      version: 2,
      updated_by: { user_id: "user_sam" },
    });

    const stale = await call(alex, "update_document", {
      file_id: file.id,
      content: "stale",
      expected_version: 1,
    });
    expect(stale.isError).toBe(true);
    expect(stale.structuredContent).toMatchObject({
      error: {
        code: "VERSION_CONFLICT",
        current_version: 2,
        expected_version: 1,
      },
    });
    expect((stale.content[0] as { text: string }).text).toContain(
      "expected_version=2",
    );

    const after = await call(alex, "read_file", { file_id: file.id });
    expect(after.structuredContent).toMatchObject({
      file: { version: 2 },
      content: "v2 content",
    });

    await Promise.all([alex.close(), sam.close()]);
  });

  it("returns FILE_NOT_FOUND for unknown file ids", async () => {
    const client = await connect("alex-token");
    const result = await call(client, "read_file", { file_id: "file_missing" });
    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe("FILE_NOT_FOUND");
    await client.close();
  });

  it("returns FORBIDDEN for workspaces the caller is not a member of", async () => {
    const client = await connect("alex-token");
    for (const [name, args] of [
      ["list_files", { workspace_id: "ws_other" }],
      [
        "create_document",
        { name: "x.md", content: "x", workspace_id: "ws_other" },
      ],
    ] as const) {
      const result = await call(client, name, args);
      expect(result.isError).toBe(true);
      expect(errorCode(result)).toBe("FORBIDDEN");
    }
    await client.close();
  });

  it("hides other tenants' files behind FILE_NOT_FOUND", async () => {
    const jordan = await connect("jordan-token");
    const alex = await connect("alex-token");
    const before = await call(alex, "read_file", { file_id: "file_brief" });

    for (const [name, args] of [
      ["read_file", { file_id: "file_brief" }],
      [
        "update_document",
        { file_id: "file_brief", content: "hijacked", expected_version: 1 },
      ],
    ] as const) {
      const result = await call(jordan, name, args);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: {
          code: "FILE_NOT_FOUND",
          message: expect.not.stringContaining("ws_demo"),
          file_id: "file_brief",
        },
      });
    }

    const after = await call(alex, "read_file", { file_id: "file_brief" });
    expect(after.structuredContent).toEqual(before.structuredContent);
    await Promise.all([jordan.close(), alex.close()]);
  });

  it("rejects parent_id until folders exist", async () => {
    const client = await connect("alex-token");
    const result = await call(client, "create_document", {
      name: "nested.md",
      content: "x",
      parent_id: "file_brief",
    });
    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe("INVALID_INPUT");
    expect((result.content[0] as { text: string }).text).toContain(
      "omit parent_id",
    );
    await client.close();
  });

  it("rejects folder_id on list_files until folders exist", async () => {
    const client = await connect("alex-token");
    const result = await call(client, "list_files", { folder_id: "folder_x" });
    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe("INVALID_INPUT");
    expect((result.content[0] as { text: string }).text).toContain(
      "omit folder_id",
    );
    await client.close();
  });

  it("rejects duplicate names in the same workspace", async () => {
    const alex = await connect("alex-token");
    const jordan = await connect("jordan-token");

    const created = await call(alex, "create_document", {
      name: "dupe.md",
      content: "original",
    });
    const file = created.structuredContent as { id: string; version: number };

    for (const name of ["dupe.md", " DUPE.md "]) {
      const result = await call(alex, "create_document", {
        name,
        content: "copy",
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: "NAME_EXISTS",
          file_id: file.id,
          name: "dupe.md",
          version: 1,
        },
      });
      expect((result.content[0] as { text: string }).text).toContain(
        "update_document",
      );
    }

    const other = await call(jordan, "create_document", {
      name: "dupe.md",
      content: "other tenant",
    });
    expect(other.isError).toBeFalsy();
    expect(other.structuredContent).toMatchObject({
      workspace_id: "ws_other",
      version: 1,
    });

    await Promise.all([alex.close(), jordan.close()]);
  });

  it("rejects expected_version ahead of the file as INVALID_INPUT", async () => {
    const client = await connect("alex-token");
    const created = await call(client, "create_document", {
      name: "ahead.md",
      content: "v1",
    });
    const { id } = created.structuredContent as { id: string };
    await call(client, "update_document", {
      file_id: id,
      content: "v2",
      expected_version: 1,
    });

    const ahead = await call(client, "update_document", {
      file_id: id,
      content: "from the future",
      expected_version: 99,
    });
    expect(ahead.isError).toBe(true);
    expect(ahead.structuredContent).toMatchObject({
      error: {
        code: "INVALID_INPUT",
        file_id: id,
        current_version: 2,
        expected_version: 99,
      },
    });
    expect((ahead.content[0] as { text: string }).text).toContain("read_file");

    const stale = await call(client, "update_document", {
      file_id: id,
      content: "stale",
      expected_version: 1,
    });
    expect(errorCode(stale)).toBe("VERSION_CONFLICT");

    const after = await call(client, "read_file", { file_id: id });
    expect(after.structuredContent).toMatchObject({
      file: { version: 2 },
      content: "v2",
    });
    await client.close();
  });

  it("get_workspace_info returns only the caller's workspaces", async () => {
    const alex = await connect("alex-token");
    const jordan = await connect("jordan-token");

    const mine = await call(alex, "get_workspace_info", {});
    expect(mine.isError).toBeFalsy();
    expect(mine.structuredContent).toEqual({
      user: { id: "user_alex" },
      client: "dev-token",
      workspaces: [
        {
          id: "ws_demo",
          name: "Demo workspace",
          role: "owner",
          member_count: 2,
          is_default: true,
        },
      ],
      // Earlier tests wrote as alex but never synced.
      connection: {
        client: "dev-token",
        last_synced_at: null,
        last_action_at: expect.any(String),
      },
    });

    const theirs = await call(jordan, "get_workspace_info", {});
    expect(theirs.structuredContent).toMatchObject({
      user: { id: "user_jordan" },
      workspaces: [{ id: "ws_other", role: "owner", member_count: 1 }],
    });
    expect(
      (theirs.structuredContent as { workspaces: unknown[] }).workspaces,
    ).toHaveLength(1);

    await Promise.all([alex.close(), jordan.close()]);
  });

  it("search_files matches names before content, within the caller's workspace", async () => {
    const alex = await connect("alex-token");
    const jordan = await connect("jordan-token");
    await call(alex, "create_document", {
      name: "zebra-notes.md",
      content: "Nothing to see.",
    });
    const filler = "lorem ipsum ".repeat(30);
    await call(alex, "create_document", {
      name: "other-notes.md",
      content: `${filler}\nThe ZEBRA plan\nlives here.\n${filler}`,
    });
    await call(jordan, "create_document", {
      name: "jordan-zebra.md",
      content: "zebra in ws_other",
    });

    const result = await call(alex, "search_files", { query: "zebra" });
    expect(result.isError).toBeFalsy();
    const { results } = result.structuredContent as {
      results: {
        file: { name: string; workspace_id: string };
        snippet: string;
        match: string;
      }[];
    };
    expect(results.map((r) => [r.file.name, r.match])).toEqual([
      ["zebra-notes.md", "name"],
      ["other-notes.md", "content"],
    ]);
    expect(results[0]!.snippet).toBe("Nothing to see.");
    const { snippet } = results[1]!;
    expect(snippet).toContain("The ZEBRA plan lives here.");
    expect(snippet).not.toContain("\n");
    expect(snippet.length).toBeLessThanOrEqual(162);

    const brief = await call(jordan, "search_files", { query: "brief" });
    expect(brief.structuredContent).toEqual({ results: [] });

    await Promise.all([alex.close(), jordan.close()]);
  });

  it("search_files rejects non-member workspaces and respects limit", async () => {
    const client = await connect("alex-token");
    const forbidden = await call(client, "search_files", {
      query: "zebra",
      workspace_id: "ws_other",
    });
    expect(forbidden.isError).toBe(true);
    expect(errorCode(forbidden)).toBe("FORBIDDEN");

    for (const n of [1, 2, 3]) {
      await call(client, "create_document", {
        name: `limit-${n}.md`,
        content: "x",
      });
    }
    const limited = await call(client, "search_files", {
      query: "limit-",
      limit: 2,
    });
    expect(
      (limited.structuredContent as { results: unknown[] }).results,
    ).toHaveLength(2);
    await client.close();
  });

  it("get_file_versions lists revisions newest first with authors", async () => {
    const alex = await connect("alex-token");
    const sam = await connect("sam-token");
    const created = await call(alex, "create_document", {
      name: "history.md",
      content: "v1",
    });
    const { id } = created.structuredContent as { id: string };
    await call(sam, "update_document", {
      file_id: id,
      content: "version two",
      expected_version: 1,
    });

    const result = await call(alex, "get_file_versions", { file_id: id });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      file: { id, version: 2 },
      versions: [
        {
          version: 2,
          author: {
            actor_type: "agent",
            user_id: "user_sam",
            client: "dev-token",
          },
          size_bytes: 11,
        },
        {
          version: 1,
          author: {
            actor_type: "agent",
            user_id: "user_alex",
            client: "dev-token",
          },
          size_bytes: 2,
        },
      ],
    });

    const one = await call(alex, "get_file_versions", {
      file_id: id,
      limit: 1,
    });
    expect(
      (one.structuredContent as { versions: { version: number }[] }).versions,
    ).toEqual([expect.objectContaining({ version: 2 })]);

    const seeded = await call(alex, "get_file_versions", {
      file_id: "file_brief",
    });
    expect(seeded.structuredContent).toMatchObject({
      versions: [
        {
          version: 1,
          author: {
            actor_type: "human",
            user_id: "user_sam",
            client: "dashboard",
          },
        },
      ],
    });

    await Promise.all([alex.close(), sam.close()]);
  });

  it("get_file_versions hides other tenants' files behind FILE_NOT_FOUND", async () => {
    const jordan = await connect("jordan-token");
    const result = await call(jordan, "get_file_versions", {
      file_id: "file_brief",
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        code: "FILE_NOT_FOUND",
        message: expect.not.stringContaining("ws_demo"),
        file_id: "file_brief",
      },
    });
    await jordan.close();
  });

  it("rejects document names over 255 characters", async () => {
    const client = await connect("alex-token");
    const result = await call(client, "create_document", {
      name: `${"a".repeat(253)}.md`,
      content: "x",
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(
      /Input validation error/,
    );
    await client.close();
  });

  it("rejects unsupported mime types", async () => {
    const client = await connect("alex-token");
    const result = await call(client, "create_document", {
      name: "doc.pdf",
      content: "x",
      mime_type: "application/pdf",
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(
      /Input validation error/,
    );
    await client.close();
  });
});

describe("context tools", () => {
  let backend: MockBackend;
  let ctxServer: Server;
  let url: URL;

  const alexHuman: Actor = {
    user_id: "user_alex",
    client: "dashboard",
    actor_type: "human",
  };
  const alexAgent: Actor = { ...alexHuman, actor_type: "agent" };

  beforeAll(async () => {
    backend = new MockBackend();
    ctxServer = createApp({
      backend,
      identity: new DevTokenResolver(DEV_TOKENS),
    });
    url = new URL("/mcp", await listen(ctxServer));
  });

  afterAll(() => stop(ctxServer));

  interface Synced {
    workspace: { id: string; name: string };
    context: {
      goal: string;
      decisions: { text: string; source_ids: string[] }[];
      ownership: { area: string; owner_user_id: string }[];
    };
    context_version: number;
    pending_proposals: Record<string, unknown>[];
    changed_files: { id: string; name: string; workspace_id: string }[];
    files_truncated: boolean;
    events: {
      seq: number;
      type: string;
      subject_id: string;
      workspace_id: string;
      actor: unknown;
      summary: string;
    }[];
    events_truncated: boolean;
    cursor: string;
  }

  async function sync(
    client: Client,
    args: Record<string, unknown> = {},
  ): Promise<Synced> {
    const result = await call(client, "sync_workspace", args);
    expect(result.isError).toBeFalsy();
    return result.structuredContent as unknown as Synced;
  }

  async function propose(client: Client, args: Record<string, unknown>) {
    const result = await call(client, "propose_context_change", {
      rationale: "The brief says so.",
      ...args,
    });
    expect(result.isError).toBeFalsy();
    return (result.structuredContent as { proposal: { id: string } }).proposal;
  }

  function messageOf(result: CallToolResult): string {
    return (result.content[0] as { text: string }).text;
  }

  it("sync without a cursor returns the context, all files, and a cursor", async () => {
    const alex = await connect("alex-token", url);
    const first = await sync(alex);
    expect(first.workspace).toEqual({ id: "ws_demo", name: "Demo workspace" });
    expect(first.context).toMatchObject({
      goal: expect.stringContaining("Tandem"),
      constraints: expect.arrayContaining([expect.any(String)]),
      decisions: [expect.objectContaining({ status: "approved" })],
      ownership: [{ area: "MCP server", owner_user_id: "user_alex" }],
    });
    expect(first.context_version).toBe(1);
    expect(first.pending_proposals).toEqual([]);
    expect(first.changed_files.map((f) => f.id)).toEqual(["file_brief"]);
    expect(first.files_truncated).toBe(false);
    expect(first.events).toEqual([
      expect.objectContaining({
        seq: 1,
        type: "file.created",
        subject_id: "file_brief",
      }),
    ]);
    expect(first.events_truncated).toBe(false);
    expect(first.cursor).toEqual(expect.any(String));

    await call(alex, "update_document", {
      file_id: "file_brief",
      content: "# Project brief\n\nSECRET-CONTENT\n",
      expected_version: 1,
    });
    const second = await sync(alex, { since: first.cursor });
    expect(second.changed_files).toEqual([
      expect.objectContaining({ id: "file_brief", version: 2 }),
    ]);
    expect(second.events).toEqual([
      {
        seq: 2,
        workspace_id: "ws_demo",
        type: "file.updated",
        subject_id: "file_brief",
        actor: {
          actor_type: "agent",
          user_id: "user_alex",
          client: "dev-token",
        },
        at: expect.any(String),
        summary: "brief.md updated to v2",
      },
    ]);
    expect(JSON.stringify(second.events)).not.toContain("SECRET-CONTENT");
    expect(second.cursor).not.toBe(first.cursor);

    const third = await sync(alex, { since: second.cursor });
    expect(third.changed_files).toEqual([]);
    expect(third.events).toEqual([]);
    expect(third.cursor).toBe(second.cursor);
    await alex.close();
  });

  it("rejects garbage and foreign cursors with INVALID_INPUT", async () => {
    const alex = await connect("alex-token", url);
    const jordan = await connect("jordan-token", url);
    const theirs = await sync(jordan);
    const forged = (w: string, s: unknown) =>
      Buffer.from(JSON.stringify({ w, s })).toString("base64url");

    for (const since of [
      "garbage",
      "",
      theirs.cursor,
      forged("ws_other", 0),
      forged("ws_demo", 9999),
      forged("ws_demo", -1),
      forged("ws_demo", "1"),
    ]) {
      const result = await call(alex, "sync_workspace", { since });
      expect(result.isError).toBe(true);
      expect(errorCode(result)).toBe("INVALID_INPUT");
      expect(messageOf(result)).toContain(
        "cursor is invalid or for another workspace; call sync_workspace without since",
      );
    }

    const mine = await sync(alex);
    const crossed = await call(alex, "sync_workspace", {
      since: mine.cursor,
      workspace_id: "ws_other",
    });
    expect(errorCode(crossed)).toBe("FORBIDDEN");
    await Promise.all([alex.close(), jordan.close()]);
  });

  it("propose_context_change creates a pending proposal and leaves context unchanged", async () => {
    const alex = await connect("alex-token", url);
    const before = await sync(alex);
    const proposal = await propose(alex, {
      field: "goal",
      proposed_value: "Win the Cal Hacks grand prize.",
      rationale: "Judges reward ambition.",
      source_ids: ["file_brief", "file_brief"],
    });
    expect(proposal).toEqual({
      id: expect.stringMatching(/^prop_/),
      workspace_id: "ws_demo",
      field: "goal",
      proposed_value: "Win the Cal Hacks grand prize.",
      rationale: "Judges reward ambition.",
      source_ids: ["file_brief"],
      status: "pending",
      proposed_by: {
        actor_type: "agent",
        user_id: "user_alex",
        client: "dev-token",
      },
      created_at: expect.any(String),
    });

    const after = await sync(alex, { since: before.cursor });
    expect(after.context).toEqual(before.context);
    expect(after.context_version).toBe(before.context_version);
    expect(after.pending_proposals).toContainEqual({
      id: proposal.id,
      field: "goal",
      rationale: "Judges reward ambition.",
      proposed_by: {
        actor_type: "agent",
        user_id: "user_alex",
        client: "dev-token",
      },
      created_at: expect.any(String),
    });
    expect(after.events).toEqual([
      expect.objectContaining({
        type: "context.proposed",
        subject_id: proposal.id,
        summary: "goal change proposed",
      }),
    ]);

    const pending = await call(alex, "get_approvals", {});
    const { proposals } = pending.structuredContent as {
      proposals: { id: string; status: string }[];
    };
    expect(proposals[0]).toMatchObject({ id: proposal.id, status: "pending" });
    const approved = await call(alex, "get_approvals", { status: "approved" });
    expect(
      (approved.structuredContent as { proposals: { id: string }[] }).proposals,
    ).not.toContainEqual(expect.objectContaining({ id: proposal.id }));
    await alex.close();
  });

  it("propose_context_change validates values, sources and rationale", async () => {
    const alex = await connect("alex-token", url);
    const cases: [Record<string, unknown>, string][] = [
      [{ field: "goal", proposed_value: ["not", "text"] }, "INVALID_INPUT"],
      [{ field: "constraints", proposed_value: "one string" }, "INVALID_INPUT"],
      [
        {
          field: "ownership",
          proposed_value: { area: "Venue", owner_user_id: "user_jordan" },
        },
        "INVALID_INPUT",
      ],
      [
        { field: "scope", proposed_value: "x", source_ids: ["file_missing"] },
        "FILE_NOT_FOUND",
      ],
    ];
    for (const [args, code] of cases) {
      const result = await call(alex, "propose_context_change", {
        rationale: "because",
        ...args,
      });
      expect(result.isError).toBe(true);
      expect(errorCode(result)).toBe(code);
    }
    for (const rationale of ["", "   ", "x".repeat(2001)]) {
      const result = await call(alex, "propose_context_change", {
        field: "goal",
        proposed_value: "x",
        rationale,
      });
      expect(result.isError).toBe(true);
      expect(messageOf(result)).toMatch(/Input validation error/);
    }
    await alex.close();
  });

  it("decideProposal by the human owner applies the change", async () => {
    const alex = await connect("alex-token", url);
    const proposal = await propose(alex, {
      field: "goal",
      proposed_value: "Ship Tandem to three pilot teams.",
    });
    const before = await sync(alex);

    const decided = await backend.decideProposal(
      alexHuman,
      proposal.id,
      "approve",
      "Agreed in standup.",
    );
    expect(decided).toMatchObject({
      status: "approved",
      decided_by: { user_id: "user_alex", actor_type: "human" },
      decided_at: expect.any(String),
      decision_note: "Agreed in standup.",
    });

    const after = await sync(alex, { since: before.cursor });
    expect(after.context.goal).toBe("Ship Tandem to three pilot teams.");
    expect(after.context_version).toBe(before.context_version + 1);
    expect(after.events).toEqual([
      expect.objectContaining({
        type: "context.approved",
        subject_id: proposal.id,
        actor: {
          actor_type: "human",
          user_id: "user_alex",
          client: "dashboard",
        },
      }),
    ]);
    expect(after.pending_proposals).not.toContainEqual(
      expect.objectContaining({ id: proposal.id }),
    );

    await expect(
      backend.decideProposal(alexHuman, proposal.id, "reject"),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const decision = await propose(alex, {
      field: "decisions",
      proposed_value: "Demo on Claude first, ChatGPT second.",
      source_ids: ["file_brief"],
    });
    const owner = await propose(alex, {
      field: "ownership",
      proposed_value: { area: "mcp SERVER ", owner_user_id: "user_sam" },
    });
    const rejected = await propose(alex, {
      field: "scope",
      proposed_value: "Everything.",
    });
    await backend.decideProposal(alexHuman, decision.id, "approve");
    await backend.decideProposal(alexHuman, owner.id, "approve");
    await backend.decideProposal(
      alexHuman,
      rejected.id,
      "reject",
      "Too broad.",
    );

    const latest = await sync(alex);
    expect(latest.context.decisions.at(-1)).toMatchObject({
      text: "Demo on Claude first, ChatGPT second.",
      status: "approved",
      source_ids: ["file_brief"],
    });
    expect(latest.context.ownership).toEqual([
      { area: "mcp SERVER", owner_user_id: "user_sam" },
    ]);
    expect(latest.context_version).toBe(after.context_version + 2);
    expect(latest.events.at(-1)).toMatchObject({
      type: "context.rejected",
      subject_id: rejected.id,
    });
    const listed = await call(alex, "get_approvals", { status: "rejected" });
    expect(listed.structuredContent).toMatchObject({
      proposals: [{ id: rejected.id, decision_note: "Too broad." }],
    });
    await alex.close();
  });

  it("only human owners decide, and agents can't change context directly", async () => {
    const alex = await connect("alex-token", url);
    const proposal = await propose(alex, {
      field: "scope",
      proposed_value: "Only the dashboard.",
    });
    const forbiddenActors: Actor[] = [
      alexAgent,
      { user_id: "user_sam", client: "dashboard", actor_type: "human" },
    ];
    for (const actor of forbiddenActors) {
      await expect(
        backend.decideProposal(actor, proposal.id, "approve"),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(
      backend.decideProposal(
        { user_id: "user_jordan", client: "dashboard", actor_type: "human" },
        proposal.id,
        "approve",
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const before = await sync(alex);
    await expect(
      backend.applyContextChange(alexAgent, { field: "goal", value: "Hijack" }),
    ).rejects.toMatchObject({
      code: "APPROVAL_REQUIRED",
      message:
        "Changes to goal, scope, decisions or ownership need human approval. Use propose_context_change.",
    });
    await expect(
      backend.applyContextChange(
        { user_id: "user_sam", client: "dashboard", actor_type: "human" },
        { field: "goal", value: "Hijack" },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const after = await sync(alex, { since: before.cursor });
    expect(after.context).toEqual(before.context);
    expect(after.context_version).toBe(before.context_version);
    expect(after.events).toEqual([]);

    const { tools } = await alex.listTools();
    expect(tools.map((t) => t.name)).not.toContain("apply_context_change");
    await alex.close();
  });

  it("applyContextChange rejects null and empty values as INVALID_INPUT", async () => {
    const alex = await connect("alex-token", url);
    const before = await sync(alex);
    const invalid = [
      { field: "goal", value: null },
      { field: "goal", value: "" },
      { field: "scope", value: "   " },
      { field: "decisions", value: "" },
      { field: "constraints", value: null },
      { field: "constraints", value: ["ok", ""] },
      { field: "constraints", value: [1, 2] },
      { field: "ownership", value: null },
      { field: "ownership", value: { area: "", owner_user_id: "user_sam" } },
      { field: "ownership", value: { area: "Backend", owner_user_id: "" } },
    ];
    for (const change of invalid) {
      await expect(
        backend.applyContextChange(
          alexHuman,
          change as unknown as Parameters<typeof backend.applyContextChange>[1],
        ),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    const after = await sync(alex, { since: before.cursor });
    expect(after.context).toEqual(before.context);
    expect(after.context_version).toBe(before.context_version);
    await alex.close();
  });

  it("publish_work records work and validates file_ids", async () => {
    const alex = await connect("alex-token", url);
    const jordan = await connect("jordan-token", url);
    const before = await sync(alex);

    const result = await call(alex, "publish_work", {
      kind: "finding",
      title: "Brief is out of date",
      summary: "The goal section predates the Convex decision.",
      file_ids: ["file_brief"],
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      published: {
        id: expect.stringMatching(/^pub_/),
        workspace_id: "ws_demo",
        kind: "finding",
        title: "Brief is out of date",
        summary: "The goal section predates the Convex decision.",
        file_ids: ["file_brief"],
        published_by: {
          actor_type: "agent",
          user_id: "user_alex",
          client: "dev-token",
        },
        created_at: expect.any(String),
      },
    });
    const after = await sync(alex, { since: before.cursor });
    expect(after.events).toEqual([
      expect.objectContaining({
        type: "work.published",
        summary: "finding published: Brief is out of date",
      }),
    ]);

    const theirFile = await call(jordan, "create_document", {
      name: "venue.md",
      content: "x",
    });
    const { id: theirId } = theirFile.structuredContent as { id: string };
    for (const [client, fileId] of [
      [alex, theirId],
      [jordan, "file_brief"],
      [alex, "file_missing"],
    ] as const) {
      const bad = await call(client, "publish_work", {
        kind: "deliverable",
        title: "t",
        summary: "s",
        file_ids: [fileId],
      });
      expect(bad.isError).toBe(true);
      expect(bad.structuredContent).toEqual({
        error: {
          code: "FILE_NOT_FOUND",
          message: expect.not.stringContaining("ws_"),
          file_id: fileId,
        },
      });
    }
    const empty = await call(alex, "publish_work", {
      kind: "finding",
      title: "",
      summary: "s",
    });
    expect(messageOf(empty)).toMatch(/Input validation error/);
    await Promise.all([alex.close(), jordan.close()]);
  });

  it("never shows ws_demo context, proposals, events or files to jordan", async () => {
    const jordan = await connect("jordan-token", url);
    const theirs = await sync(jordan);
    expect(theirs.workspace.id).toBe("ws_other");
    expect(theirs.context.goal).toBe("Plan the spring community meetup.");
    const leaked = JSON.stringify(theirs);
    expect(leaked).not.toContain("ws_demo");
    expect(leaked).not.toContain("file_brief");
    expect(leaked).not.toContain("Tandem");

    const approvals = await call(jordan, "get_approvals", { status: "all" });
    expect(approvals.structuredContent).toEqual({ proposals: [] });

    for (const [name, args] of [
      ["sync_workspace", { workspace_id: "ws_demo" }],
      ["get_approvals", { workspace_id: "ws_demo" }],
      [
        "propose_context_change",
        {
          workspace_id: "ws_demo",
          field: "goal",
          proposed_value: "x",
          rationale: "x",
        },
      ],
      [
        "publish_work",
        { workspace_id: "ws_demo", kind: "finding", title: "t", summary: "s" },
      ],
    ] as const) {
      const result = await call(jordan, name, args);
      expect(result.isError).toBe(true);
      expect(errorCode(result)).toBe("FORBIDDEN");
    }
    await jordan.close();
  });

  it("get_workspace_info shows last_synced_at and last_action_at", async () => {
    const sam = await connect("sam-token", url);
    const info = async () =>
      (
        (await call(sam, "get_workspace_info", {})).structuredContent as {
          connection: unknown;
        }
      ).connection;
    expect(await info()).toEqual({
      client: "dev-token",
      last_synced_at: null,
      last_action_at: null,
    });
    await sync(sam);
    expect(await info()).toEqual({
      client: "dev-token",
      last_synced_at: expect.any(String),
      last_action_at: null,
    });
    await propose(sam, { field: "scope", proposed_value: "Smaller." });
    expect(await info()).toEqual({
      client: "dev-token",
      last_synced_at: expect.any(String),
      last_action_at: expect.any(String),
    });
    await sam.close();
  });

  it("pages events and caps files at 50", async () => {
    const jordanAgent: Actor = {
      user_id: "user_jordan",
      client: "dev-token",
      actor_type: "agent",
    };
    const jordan = await connect("jordan-token", url);
    const start = await sync(jordan);
    for (let i = 0; i < 55; i++) {
      await backend.createDocument(jordanAgent, {
        name: `page-${i}.md`,
        content: "x",
        mime_type: "text/markdown",
      });
    }

    const snapshot = await sync(jordan);
    expect(snapshot.changed_files).toHaveLength(50);
    expect(snapshot.files_truncated).toBe(true);
    expect(snapshot.events).toHaveLength(50);
    expect(snapshot.events_truncated).toBe(true);

    const page1 = await sync(jordan, { since: start.cursor });
    expect(page1.events).toHaveLength(50);
    expect(page1.events_truncated).toBe(true);
    expect(page1.events[0]!.seq).toBe((start.events.at(-1)?.seq ?? 0) + 1);
    const page2 = await sync(jordan, { since: page1.cursor });
    expect(page2.events.map((e) => e.summary)).toEqual(
      [50, 51, 52, 53, 54].map((i) => `page-${i}.md created`),
    );
    expect(page2.changed_files).toHaveLength(5);
    expect(page2.events_truncated).toBe(false);
    expect(page2.cursor).toBe(snapshot.cursor);
    await jordan.close();
  });
});

describe("dev anon mode", () => {
  let anonServer: Server;
  let anonUrl: URL;

  beforeAll(async () => {
    anonServer = createApp({
      backend: new MockBackend(),
      identity: withDevAnon(new DevTokenResolver(DEV_TOKENS), {
        TANDEM_DEV_ANON_USER: "user_alex",
        TANDEM_BACKEND: "mock",
      }),
    });
    anonUrl = new URL("/mcp", await listen(anonServer));
  });

  afterAll(() => stop(anonServer));

  it("acts as the anon user when there is no api-key header", async () => {
    const client = await connect(null, anonUrl);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("read_file");

    const read = await call(client, "read_file", { file_id: "file_brief" });
    expect(read.isError).toBeFalsy();
    expect(read.structuredContent).toMatchObject({
      file: { id: "file_brief" },
    });

    const created = await call(client, "create_document", {
      name: "anon.md",
      content: "x",
    });
    expect(created.structuredContent).toMatchObject({
      updated_by: { user_id: "user_alex", client: "dev-anon" },
    });
    await client.close();
  });

  it("still resolves real api keys through the token resolver", async () => {
    const client = await connect("sam-token", anonUrl);
    const created = await call(client, "create_document", {
      name: "sam.md",
      content: "x",
    });
    expect(created.structuredContent).toMatchObject({
      updated_by: { user_id: "user_sam", client: "dev-token" },
    });
    await client.close();
  });

  it("rejects invalid or empty api keys instead of downgrading to anon", async () => {
    for (const apiKey of ["nope", "", "Bearer sam-token"]) {
      const res = await post(anonUrl, { "api-key": apiKey });
      expect(res.status).toBe(401);
    }
  });

  it("treats a request with only an Authorization header as anon", async () => {
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(anonUrl, {
        requestInit: { headers: { Authorization: "Bearer sam-token" } },
      }),
    );
    const created = await call(client, "create_document", {
      name: "auth-header.md",
      content: "x",
    });
    expect(created.structuredContent).toMatchObject({
      updated_by: { user_id: "user_alex", client: "dev-anon" },
    });
    await client.close();
  });

  it("is off unless TANDEM_DEV_ANON_USER is set", () => {
    const tokens = new DevTokenResolver(DEV_TOKENS);
    expect(withDevAnon(tokens, {})).toBe(tokens);
    expect(withDevAnon(tokens, { TANDEM_DEV_ANON_USER: " " })).toBe(tokens);
  });

  it("refuses to enable outside mock dev", () => {
    const tokens = new DevTokenResolver(DEV_TOKENS);
    for (const env of [
      { TANDEM_DEV_ANON_USER: "user_alex", NODE_ENV: "production" },
      { TANDEM_DEV_ANON_USER: "user_alex", TANDEM_BACKEND: "convex" },
    ]) {
      expect(() => withDevAnon(tokens, env)).toThrow(/TANDEM_DEV_ANON_USER/);
    }
  });
});
