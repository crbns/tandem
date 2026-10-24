import type { AddressInfo } from "node:net";
import { request, type Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DevAnonResolver,
  DevTokenResolver,
  apiKeyFromHeader,
  withDevAnon,
} from "../src/auth.js";
import { MockBackend } from "../src/backend/mock.js";
import type { Actor, StructuredContext } from "../src/backend/types.js";
import { TandemError } from "../src/errors.js";
import {
  MCP_INSTRUCTIONS,
  proposedNextSteps,
  publishedNextSteps,
  savedNextSteps,
  syncNextSteps,
} from "../src/loop.js";
import { isValidName, nameKey, storedName } from "../src/names.js";
import { createApp, parseAllowedOrigins } from "../src/server.js";

const DEV_TOKENS =
  "alex-token:user_alex,sam-token:user_sam,jordan-token:user_jordan,taylor-token:user_taylor";

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

// A fresh server and MockBackend per test, so tests never share file names.
beforeEach(async () => {
  server = createApp({
    backend: new MockBackend(),
    identity: new DevTokenResolver(DEV_TOKENS),
  });
  baseUrl = await listen(server);
  mcpUrl = new URL("/mcp", baseUrl);
});

afterEach(() => stop(server));

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

/** Raw POST that sends `api-key` once per value, which fetch can't do. */
function postRepeatedApiKey(url: URL, values: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST" }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.setHeader("Content-Type", "application/json");
    req.setHeader("api-key", values);
    req.on("error", reject);
    req.end("{}");
  });
}

function text(result: CallToolResult): string {
  return (result.content[0] as { text: string }).text;
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
      expect(res.headers.get("www-authenticate")).toBe('ApiKey realm="tandem"');
      expect(await res.json()).toEqual({
        error: {
          code: "UNAUTHENTICATED",
          message: "Missing or invalid api-key header.",
        },
      });
    }
  });

  it("rejects comma-containing and repeated api-key headers", async () => {
    for (const apiKey of ["alex-token,sam-token", "alex-token, alex-token"]) {
      const res = await post(mcpUrl, { "api-key": apiKey });
      expect(res.status).toBe(401);
    }
    expect(await postRepeatedApiKey(mcpUrl, ["alex-token", "alex-token"])).toBe(
      401,
    );
    expect(apiKeyFromHeader("a,b")).toBeNull();
    expect(apiKeyFromHeader(" alex-token ")).toBe("alex-token");
  });

  it("rejects /mcp requests from a browser Origin by default", async () => {
    const res = await post(mcpUrl, {
      "api-key": "alex-token",
      Origin: "http://evil.example",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "FORBIDDEN", message: "Origin not allowed." },
    });
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

  it("lists exactly the fourteen tools", async () => {
    const client = await connect("alex-token");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "create_document",
      "create_folder",
      "get_approvals",
      "get_file_versions",
      "get_workspace_info",
      "list_files",
      "move_file",
      "move_folder",
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
      create_folder: idempotentWrite,
      move_file: idempotentWrite,
      move_folder: idempotentWrite,
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
      agent_connection_id: "conn_user_alex_dev-token",
      label: "user_alex's dev-token assistant",
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

  it("rejects duplicate names in the same workspace", async () => {
    const alex = await connect("alex-token");
    const jordan = await connect("jordan-token");

    const created = await call(alex, "create_document", {
      name: "dupe.md",
      content: "original",
    });
    const file = created.structuredContent as { id: string; version: number };
    await call(alex, "update_document", {
      file_id: file.id,
      content: "edited",
      expected_version: 1,
    });

    for (const name of ["dupe.md", " DUPE.md "]) {
      const result = await call(alex, "create_document", {
        name,
        content: "copy",
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: {
          code: "NAME_EXISTS",
          message: expect.stringContaining('"dupe.md"'),
          kind: "file",
          file_id: file.id,
          name: "dupe.md",
          current_version: 2,
        },
      });
      expect(text(result)).toContain("update_document");
    }

    const listed = await call(alex, "list_files", { query: "dupe" });
    const { files } = listed.structuredContent as {
      files: { id: string; version: number }[];
    };
    expect(files).toEqual([
      expect.objectContaining({ id: file.id, version: 2 }),
    ]);

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

  it("rejects expected_version ahead of the file as VERSION_CONFLICT, as Convex does", async () => {
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
        code: "VERSION_CONFLICT",
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
          member_count: 3,
          is_default: true,
        },
      ],
      // Members of the default workspace, for ownership proposals.
      members: [
        { user_id: "user_alex", name: "Alex", role: "owner" },
        { user_id: "user_sam", name: "Sam", role: "member" },
        { user_id: "user_taylor", name: "Taylor", role: "admin" },
      ],
      members_truncated: false,
      // A fresh connection has not synced or written.
      connection: {
        client: "dev-token",
        last_synced_at: null,
        last_action_at: null,
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
    // Only their own workspace's members.
    expect(
      (theirs.structuredContent as { members: unknown[] }).members,
    ).toEqual([{ user_id: "user_jordan", name: "Jordan", role: "owner" }]);

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
            agent_connection_id: "conn_user_alex_dev-token",
            label: "user_alex's dev-token assistant",
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

  it("stores names trimmed and rejects whitespace-only names", async () => {
    const client = await connect("alex-token");
    const created = await call(client, "create_document", {
      name: "  spaced.md\t",
      content: "x",
    });
    expect(created.structuredContent).toMatchObject({ name: "spaced.md" });

    for (const name of ["   ", "\t\n", "x".repeat(256)]) {
      const result = await call(client, "create_document", {
        name,
        content: "x",
      });
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/Input validation error/);
    }
    const blank = await call(client, "create_document", {
      name: "   ",
      content: "x",
    });
    expect(text(blank)).toMatch(/name must contain a visible character/);
    await client.close();
  });

  it("stores names NFC-normalized without zero-width characters", async () => {
    const client = await connect("alex-token");
    const created = await call(client, "create_document", {
      name: "\u200Bcafe\u0301\u2060 notes.md\uFEFF",
      content: "x",
    });
    expect(created.structuredContent).toMatchObject({
      name: "caf\u00e9 notes.md",
    });
    await client.close();
  });

  it("treats Unicode and whitespace variants of a name as duplicates", async () => {
    const client = await connect("alex-token");
    for (const [first, second] of [
      ["caf\u00e9.md", "cafe\u0301.md"], // NFC vs NFD
      ["zw.md", "zw.md\u200B"], // trailing zero-width space
      ["my notes.md", "my  notes.md"], // double internal space
      ["\ufb01le.md", "file.md"], // NFKC ligature
      ["Stra\u00dfe.md", "STRASSE.md"], // sharp s case-folds to "ss"
    ]) {
      const created = await call(client, "create_document", {
        name: first,
        content: "x",
      });
      expect(created.isError).toBeFalsy();
      const duplicate = await call(client, "create_document", {
        name: second,
        content: "x",
      });
      expect(errorCode(duplicate)).toBe("NAME_EXISTS");
    }
    await client.close();
  });

  it("rejects non-positive or fractional expected_version", async () => {
    const client = await connect("alex-token");
    for (const expected_version of [0, -1, 1.5]) {
      const result = await call(client, "update_document", {
        file_id: "file_brief",
        content: "bad",
        expected_version,
      });
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/Input validation error/);
    }
    const after = await call(client, "read_file", { file_id: "file_brief" });
    expect(after.structuredContent).toMatchObject({ file: { version: 1 } });
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

describe("read-before / write-back loop", () => {
  it("sends the loop as server instructions at initialize", async () => {
    const client = await connect("alex-token");
    expect(client.getInstructions()).toBe(MCP_INSTRUCTIONS);
    for (const term of [
      "sync_workspace",
      "read_file",
      "update_document",
      "expected_version",
      "publish_work",
      "propose_context_change",
      "without waiting to be asked",
      "best effort",
      "private conversation history",
      "untrusted",
      "even if no file changed",
      "create or edit",
      "that context lacks",
      "no pending proposal covers",
      "read brief first",
    ])
      expect(MCP_INSTRUCTIONS).toContain(term);
    expect(MCP_INSTRUCTIONS).not.toMatch(/real[- ]time|push notification|guarantee/i);
    expect(MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(1300);
    await client.close();
  });

  it("restates the loop in next_steps on sync, save, publish and propose results", async () => {
    const client = await connect("alex-token");
    const ok = async (name: string, args: Record<string, unknown>) => {
      const result = await call(client, name, args);
      expect(result.isError).toBeFalsy();
      return result.structuredContent as Record<string, any>;
    };

    // The demo workspace has an approved goal, so no context-seeding step.
    expect((await ok("sync_workspace", {})).next_steps).toEqual(
      syncNextSteps({ contextEmpty: false }),
    );

    const created = await ok("create_document", { name: "loop.md", content: "v1" });
    expect(created).toMatchObject({ path: "/loop.md", version: 1 });
    expect(created.next_steps).toEqual(
      savedNextSteps({ id: created.id, version: 1 }),
    );
    // The text block the model reads carries the same hints.
    const updated = await call(client, "update_document", {
      file_id: created.id,
      content: "v2",
      expected_version: 1,
    });
    const { next_steps } = JSON.parse(text(updated));
    expect(next_steps[0]).toContain("expected_version=2");
    expect(next_steps[1]).toContain(`["${created.id}"]`);
    expect(next_steps[2]).toContain("approved context lacks and no pending proposal");
    expect(next_steps[2]).toContain(`source_ids ["${created.id}"]`);

    const published = await ok("publish_work", {
      kind: "deliverable",
      title: "Loop",
      summary: "Done",
      file_ids: [created.id],
    });
    expect(published.next_steps).toEqual(publishedNextSteps());

    const proposed = await ok("propose_context_change", {
      field: "goal",
      proposed_value: "Ship the loop",
      rationale: "Kickoff",
    });
    expect(proposed.proposal.status).toBe("pending");
    expect(proposed.next_steps).toEqual(proposedNextSteps("pending"));
    await client.close();
  });

  it("asks to seed the context when the approved context is empty", async () => {
    const backend = new MockBackend();
    // Empty the seeded demo context in place; no tool clears goal or scope.
    const { context } = (
      backend as unknown as {
        workspaces: Map<string, { context: StructuredContext }>;
      }
    ).workspaces.get("ws_demo")!;
    Object.assign(context, {
      goal: "",
      scope: "",
      constraints: [],
      decisions: [],
      ownership: [],
      open_questions: [],
    });
    const app = createApp({
      backend,
      identity: new DevTokenResolver(DEV_TOKENS),
    });
    const client = await connect(
      "alex-token",
      new URL("/mcp", await listen(app)),
    );
    const result = await call(client, "sync_workspace", {});
    expect(result.isError).toBeFalsy();
    const { next_steps } = result.structuredContent as { next_steps: string[] };
    expect(next_steps).toEqual(syncNextSteps({ contextEmpty: true }));
    expect(next_steps[0]).toMatch(/context is empty.*no pending proposal/);
    await client.close();
    await stop(app);
  });

  it("keeps next_steps off read and error results", async () => {
    const client = await connect("alex-token");
    const read = await call(client, "read_file", { file_id: "file_brief" });
    expect(read.structuredContent).not.toHaveProperty("next_steps");
    const stale = await call(client, "update_document", {
      file_id: "file_brief",
      content: "x",
      expected_version: 99,
    });
    expect(stale.isError).toBe(true);
    expect(stale.structuredContent).not.toHaveProperty("next_steps");
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

  beforeEach(async () => {
    backend = new MockBackend();
    ctxServer = createApp({
      backend,
      identity: new DevTokenResolver(DEV_TOKENS),
    });
    url = new URL("/mcp", await listen(ctxServer));
  });

  afterEach(() => stop(ctxServer));

  interface Synced {
    workspace: { id: string; name: string };
    context: StructuredContext;
    context_version: number;
    pending_proposals: Record<string, unknown>[];
    changed_files: { id: string; name: string; workspace_id: string }[];
    files_truncated: boolean;
    recent_work: { id: string; summary: string; file_ids: string[] }[];
    work_truncated: boolean;
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
      constraints: expect.arrayContaining([
        expect.objectContaining({
          id: expect.any(String),
          text: expect.any(String),
          status: "active",
        }),
      ]),
      decisions: [expect.objectContaining({ status: "active" })],
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
          agent_connection_id: "conn_user_alex_dev-token",
          label: "user_alex's dev-token assistant",
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

  it("delivers work exactly once while draining event pages without gaps", async () => {
    const alex = await connect("alex-token", url);
    const sam = await connect("sam-token", url);
    try {
      const before = await sync(sam);
      for (let version = 1; version <= 50; version++) {
        const updated = await call(alex, "update_document", {
          file_id: "file_brief", expected_version: version, content: `Update ${version}`,
        });
        expect(updated.isError).toBeFalsy();
      }
      const result = await call(alex, "publish_work", {
        kind: "finding", title: "After the backlog", summary: "Full finding after 50 updates",
        file_ids: ["file_brief"],
      });
      expect(result.isError).toBeFalsy();
      const published = (result.structuredContent as { published: unknown }).published;
      const first = await sync(sam, { since: before.cursor });
      expect(first.events).toHaveLength(50);
      expect(first.events_truncated).toBe(true);
      expect(first.recent_work).toEqual([]);
      expect(first.work_truncated).toBe(false);
      const second = await sync(sam, { since: first.cursor });
      expect(second.events_truncated).toBe(false);
      expect(second.recent_work).toEqual([published]);
      expect(second.work_truncated).toBe(false);
      const startSeq = before.events.at(-1)!.seq;
      expect([...first.events, ...second.events].map((e) => e.seq)).toEqual(
        Array.from({ length: 51 }, (_, i) => startSeq + i + 1),
      );
      expect([...first.recent_work, ...second.recent_work]).toEqual([published]);
      const empty = await sync(sam, { since: second.cursor });
      expect(empty.events).toEqual([]);
      expect(empty.recent_work).toEqual([]);
    } finally {
      await Promise.all([alex.close(), sam.close()]);
    }
  });

  it("sync includes teammates' published work with bounded snapshot and cursor parity", async () => {
    const alex = await connect("alex-token", url);
    const sam = await connect("sam-token", url);
    const before = await sync(sam);
    expect(before.recent_work).toEqual([]);
    expect(before.work_truncated).toBe(false);
    const published = [];
    for (let i = 0; i < 21; i++) {
      const result = await call(alex, "publish_work", {
        kind: "finding",
        title: `Finding ${i}`,
        summary: `Full finding ${i}`,
        file_ids: ["file_brief"],
      });
      expect(result.isError).toBeFalsy();
      published.push(
        (result.structuredContent as { published: unknown }).published,
      );
    }
    const after = await sync(sam, { since: before.cursor });
    expect(after.recent_work).toEqual(published.slice(-20).reverse());
    expect(after.recent_work[0]).toMatchObject({
      summary: "Full finding 20",
      file_ids: ["file_brief"],
    });
    expect(after.work_truncated).toBe(true);
    expect((await sync(sam)).recent_work).toEqual(after.recent_work);
    const empty = await sync(sam, { since: after.cursor });
    expect(empty.recent_work).toEqual([]);
    expect(empty.work_truncated).toBe(false);
    await alex.close();
    await sam.close();
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
      base_context_version: before.context_version,
      id: expect.stringMatching(/^prop_/),
      workspace_id: "ws_demo",
      field: "goal",
      proposed_value: "Win the Cal Hacks grand prize.",
      rationale: "Judges reward ambition.",
      source_ids: ["file_brief"],
      status: "pending",
      supersedes: null,
      proposed_by: {
        actor_type: "agent",
        user_id: "user_alex",
        client: "dev-token",
        agent_connection_id: "conn_user_alex_dev-token",
        label: "user_alex's dev-token assistant",
      },
      created_at: expect.any(String),
    });

    const after = await sync(alex, { since: before.cursor });
    expect(after.context).toEqual(before.context);
    expect(after.context_version).toBe(before.context_version);
    expect(after.pending_proposals).toContainEqual({
      proposed_value: "Win the Cal Hacks grand prize.",
      status: "pending",
      supersedes: null,
      id: proposal.id,
      field: "goal",
      rationale: "Judges reward ambition.",
      proposed_by: {
        actor_type: "agent",
        user_id: "user_alex",
        client: "dev-token",
        agent_connection_id: "conn_user_alex_dev-token",
        label: "user_alex's dev-token assistant",
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
    const stale = await call(alex, "get_approvals", { status: "stale" });
    expect(stale.isError).toBeFalsy();
    expect(
      (stale.structuredContent as { proposals: { id: string }[] }).proposals,
    ).not.toContainEqual(expect.objectContaining({ id: proposal.id }));
    await alex.close();
  });

  it("propose_context_change validates values, sources and rationale", async () => {
    const alex = await connect("alex-token", url);
    // Lists are not part of the contract (constraints take one string each).
    for (const args of [
      { field: "goal", proposed_value: ["not", "text"] },
      { field: "constraints", proposed_value: ["Ship by Friday", "No PII"] },
      { field: "constraints", proposed_value: "   " },
    ]) {
      const result = await call(alex, "propose_context_change", {
        rationale: "because",
        ...args,
      });
      expect(result.isError).toBe(true);
      expect(messageOf(result)).toMatch(/Input validation error/);
    }
    const cases: [Record<string, unknown>, string][] = [
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
    await backend.decideProposal(alexHuman, decision.id, "approve");
    // Working constraints apply immediately.
    const constraint = await propose(alex, {
      field: "constraints",
      proposed_value: " Keep the demo under three minutes. ",
    });
    expect(constraint).toMatchObject({ status: "applied" });
    const owner = await propose(alex, {
      field: "ownership",
      proposed_value: { area: "mcp SERVER ", owner_user_id: "user_sam" },
    });
    const rejected = await propose(alex, {
      field: "scope",
      proposed_value: "Everything.",
    });
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
      status: "active",
      source_ids: ["file_brief"],
    });
    expect(latest.context.ownership).toEqual([
      expect.objectContaining({
        area: "mcp SERVER",
        owner_user_id: "user_sam",
        status: "active",
      }),
    ]);
    expect(latest.context.constraints).toEqual([
      ...after.context.constraints,
      expect.objectContaining({
        text: "Keep the demo under three minutes.",
        status: "active",
      }),
    ]);
    expect(latest.context_version).toBe(after.context_version + 3);
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

  it("applies working questions immediately, resolves with version checks, and permits only human removal", async () => {
    const alex = await connect("alex-token", url);
    const before = await backend.syncWorkspace(alexAgent, {});
    const added = await propose(alex, {
      field: "open_questions",
      proposed_value: "Which client first?",
    });
    expect(added).toMatchObject({ status: "applied", supersedes: null });
    const active = await backend.syncWorkspace(alexAgent, {});
    const question = active.context.open_questions.at(-1)!;
    expect(question).toMatchObject({
      id: expect.any(String),
      status: "active",
      resolved_by: null,
      resolved_at: null,
    });
    expect(active.context_version).toBe(before.context_version + 1);
    expect(active.pending_proposals).not.toContainEqual(
      expect.objectContaining({ id: added.id }),
    );
    const resolve = {
      field: "open_questions" as const,
      rationale: "Answered",
      operation: "resolve" as const,
      entry_id: question.id,
    };
    await expect(
      backend.proposeContextChange(alexAgent, resolve),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      backend.proposeContextChange(alexAgent, {
        ...resolve,
        expected_version: before.context_version,
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    const resolved = await propose(alex, {
      ...resolve,
      expected_version: active.context_version,
    });
    expect(resolved).toMatchObject({ status: "applied" });
    const after = await backend.syncWorkspace(alexAgent, {});
    expect(after.context.open_questions.at(-1)).toMatchObject({
      id: question.id,
      status: "resolved",
      resolved_by: { actor_type: "agent" },
      resolved_at: expect.any(Number),
    });
    const constraint = after.context.constraints[0]!;
    const remove = {
      field: "constraints" as const,
      proposed_value: constraint.text,
      rationale: "Outdated",
      operation: "remove" as const,
      entry_id: constraint.id,
      expected_version: after.context_version,
    };
    await expect(
      backend.proposeContextChange(alexAgent, remove),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      backend.proposeContextChange(alexHuman, remove),
    ).resolves.toMatchObject({ status: "applied" });
    expect(
      (await backend.syncWorkspace(alexAgent, {})).context.constraints.map(
        (e) => e.id,
      ),
    ).not.toContain(constraint.id);
    await alex.close();
  });

  it("resolves long dashboard questions using their stored value and ignores supplied proposed_value", async () => {
    const alex = await connect("alex-token", url);
    try {
      for (const supplied of [undefined, null, { ignored: true }, "x".repeat(3000)]) {
        const questionText = `Dashboard question: ${"q".repeat(2100)}`;
        await backend.applyContextChange(alexHuman, {
          field: "open_questions",
          value: questionText,
        });
        const active = await sync(alex);
        const question = active.context.open_questions.at(-1)!;
        const result = await call(alex, "propose_context_change", {
          field: "open_questions",
          operation: "resolve",
          entry_id: question.id,
          expected_version: active.context_version,
          rationale: "Answered",
          ...(supplied === undefined ? {} : { proposed_value: supplied }),
        });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
          proposal: { status: "applied", proposed_value: questionText },
        });
        expect((await sync(alex)).context.open_questions.at(-1)).toMatchObject({
          id: question.id,
          text: questionText,
          status: "resolved",
          resolved_by: { actor_type: "agent" },
          resolved_at: expect.any(Number),
        });
      }
    } finally {
      await alex.close();
    }
  });

  it("retains decision identity and history until a superseding proposal is approved", async () => {
    const alex = await connect("alex-token", url);
    const old = (await backend.syncWorkspace(alexAgent, {})).context
      .decisions[0]!;
    const replacement = await propose(alex, {
      field: "decisions",
      proposed_value: "Use Convex with scoped MCP tokens.",
      supersedes: old.id,
    });
    expect(replacement).toMatchObject({
      status: "pending",
      supersedes: old.id,
    });
    expect(
      (await backend.syncWorkspace(alexAgent, {})).context.decisions[0],
    ).toEqual(old);
    await backend.decideProposal(alexHuman, replacement.id, "approve");
    const history = (await backend.syncWorkspace(alexAgent, {})).context
      .decisions;
    expect(history[0]).toMatchObject({
      id: old.id,
      status: "superseded",
      superseded_by: history.at(-1)!.id,
    });
    expect(history.at(-1)).toMatchObject({
      status: "active",
      text: "Use Convex with scoped MCP tokens.",
    });
    await alex.close();
  });

  it("rejects stale approvals without changing context and allows stale rejection", async () => {
    const alex = await connect("alex-token", url);
    const first = await propose(alex, {
      field: "goal",
      proposed_value: "First approved goal.",
    });
    const second = await propose(alex, {
      field: "goal",
      proposed_value: "Stale goal.",
    });
    expect(first).toMatchObject({ base_context_version: 1 });
    expect(second).toMatchObject({ base_context_version: 1 });
    await backend.decideProposal(alexHuman, first.id, "approve");
    const before = await sync(alex);
    expect(before.context_version).toBe(2);
    expect(before.context.goal).toBe("First approved goal.");
    await expect(
      backend.decideProposal(alexHuman, second.id, "approve"),
    ).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      details: {
        proposal_id: second.id,
        base_context_version: 1,
        context_version: 2,
      },
    });
    const after = await sync(alex, { since: before.cursor });
    expect(after.context).toEqual(before.context);
    expect(after.context_version).toBe(2);
    expect(after.events).toEqual([]);
    const pending = await call(alex, "get_approvals", {});
    expect(pending.structuredContent).toMatchObject({
      proposals: [
        { id: second.id, status: "pending", base_context_version: 1 },
      ],
    });
    expect(
      await backend.decideProposal(alexHuman, second.id, "reject"),
    ).toMatchObject({ status: "rejected" });
    const rejected = await sync(alex, { since: after.cursor });
    expect(rejected.context).toEqual(before.context);
    expect(rejected.context_version).toBe(2);
    expect(rejected.events).toEqual([
      expect.objectContaining({
        type: "context.rejected",
        subject_id: second.id,
      }),
    ]);
    await alex.close();
  });

  it.each(["user_alex", "user_taylor"])(
    "direct context changes by %s invalidate pending proposals",
    async (user_id) => {
      const alex = await connect("alex-token", url);
      const proposal = await propose(alex, {
        field: "goal",
        proposed_value: "Old proposal.",
      });
      const human = { ...alexHuman, user_id };
      const direct = await backend.applyContextChange(human, {
        field: "goal",
        value: "Direct human goal.",
      });
      expect(direct.context_version).toBe(2);
      await expect(
        backend.decideProposal(human, proposal.id, "approve"),
      ).rejects.toMatchObject({
        code: "VERSION_CONFLICT",
        details: { base_context_version: 1, context_version: 2 },
      });
      expect((await sync(alex)).context.goal).toBe("Direct human goal.");
      await backend.decideProposal(human, proposal.id, "reject");
      await alex.close();
    },
  );

  it("get_workspace_info reports the admin role", async () => {
    const admin = await connect("taylor-token", url);
    const result = await call(admin, "get_workspace_info", {});
    expect(result.structuredContent).toMatchObject({
      user: { id: "user_taylor" },
      workspaces: [{ id: "ws_demo", role: "admin", member_count: 3 }],
    });
    await admin.close();
  });

  it("human admins can approve, reject, and apply context changes", async () => {
    const alex = await connect("alex-token", url);
    const admin: Actor = { ...alexHuman, user_id: "user_taylor" };
    const proposal = await propose(alex, {
      field: "goal",
      proposed_value: "Ship with admin approval.",
    });
    await expect(
      backend.decideProposal(
        { ...admin, actor_type: "agent" },
        proposal.id,
        "approve",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const approved = await backend.decideProposal(
      admin,
      proposal.id,
      "approve",
    );
    expect(approved).toMatchObject({
      status: "approved",
      decided_by: { user_id: "user_taylor", actor_type: "human" },
    });
    expect((await sync(alex)).context.goal).toBe("Ship with admin approval.");
    const rejected = await propose(alex, {
      field: "goal",
      proposed_value: "Rejected.",
    });
    expect(
      await backend.decideProposal(admin, rejected.id, "reject"),
    ).toMatchObject({ status: "rejected" });
    const direct = await backend.applyContextChange(admin, {
      field: "goal",
      value: "Applied by admin.",
    });
    expect(direct.context.goal).toBe("Applied by admin.");
    await alex.close();
  });

  it("only human owners and admins decide, and agents can't change context directly", async () => {
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
          agent_connection_id: "conn_user_alex_dev-token",
          label: "user_alex's dev-token assistant",
        },
        created_at: expect.any(String),
      },
      next_steps: publishedNextSteps(),
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

describe("file system", () => {
  interface Folder {
    id: string;
    parent_id: string | null;
    name: string;
    path: string;
    revision: number;
  }
  interface File {
    id: string;
    parent_id: string | null;
    name: string;
    path: string;
    version: number;
  }
  interface Listing {
    folder: { id: string | null; path: string };
    folders: Folder[];
    files: File[];
    truncated: boolean;
  }

  async function ok<T>(client: Client, name: string, args: Record<string, unknown>) {
    const result = await call(client, name, args);
    expect(result.isError, text(result)).toBeFalsy();
    return result.structuredContent as T;
  }

  async function mkdir(client: Client, path: string) {
    return ok<{ folder: Folder; created: boolean }>(client, "create_folder", {
      path,
    });
  }

  it("create_folder makes missing parents and is idempotent", async () => {
    const alex = await connect("alex-token");
    const first = await mkdir(alex, "/specs/api");
    expect(first).toEqual({
      created: true,
      folder: {
        id: expect.any(String),
        parent_id: expect.any(String),
        name: "api",
        path: "/specs/api",
        revision: 1,
        updated_at: expect.any(String),
      },
    });

    // Same folder by nameKey, without the leading slash, with a trailing one.
    const again = await mkdir(alex, "SPECS/Api/");
    expect(again).toEqual({ created: false, folder: first.folder });
    const parent = await mkdir(alex, "/specs");
    expect(parent.created).toBe(false);
    expect(first.folder.parent_id).toBe(parent.folder.id);

    const root = await ok<Listing>(alex, "list_files", {});
    expect(root.folder).toEqual({ id: null, path: "/" });
    expect(root.folders.map((f) => f.path)).toEqual(["/specs"]);
    expect(root.files.map((f) => f.path)).toEqual(["/brief.md"]);

    const snapshot = await ok<{
      folders: Folder[];
      folders_truncated: boolean;
      events: { type: string; subject_id: string; summary: string }[];
    }>(alex, "sync_workspace", {});
    expect(snapshot.folders.map((f) => f.path)).toEqual(["/specs", "/specs/api"]);
    expect(snapshot.folders_truncated).toBe(false);
    expect(
      snapshot.events.filter((e) => e.type === "folder.created"),
    ).toEqual([
      expect.objectContaining({ subject_id: parent.folder.id, summary: "Created folder specs" }),
      expect.objectContaining({ subject_id: first.folder.id, summary: "Created folder api" }),
    ]);

    const jordan = await connect("jordan-token");
    const other = await mkdir(jordan, "/specs/api");
    expect(other.created).toBe(true);
    expect(other.folder.id).not.toBe(first.folder.id);
    await Promise.all([alex.close(), jordan.close()]);
  });

  it("rejects bad paths, the root, and paths through a file", async () => {
    const alex = await connect("alex-token");
    for (const path of ["/a//b", "/a/../b", "./a", "//", ""]) {
      const result = await call(alex, "create_folder", { path });
      expect(errorCode(result)).toBe("INVALID_PATH");
    }
    expect(errorCode(await call(alex, "create_folder", { path: "/" }))).toBe(
      "INVALID_PATH",
    );

    const through = await call(alex, "create_folder", { path: "/brief.md/x" });
    expect(through.structuredContent).toMatchObject({
      error: { code: "NAME_EXISTS", kind: "file", file_id: "file_brief" },
    });
    const deep = Array.from({ length: 33 }, (_, i) => `d${i}`).join("/");
    expect(errorCode(await call(alex, "create_folder", { path: deep }))).toBe(
      "FOLDER_TOO_DEEP",
    );
    const root = await ok<Listing>(alex, "list_files", {});
    expect(root.folders).toEqual([]);
    await alex.close();
  });

  it("creates documents in folders by folder_path or parent_id and reads them by path", async () => {
    const alex = await connect("alex-token");
    const sam = await connect("sam-token");
    const { folder } = await mkdir(alex, "/specs/api");

    const byPath = await ok<File>(alex, "create_document", {
      name: "endpoints.md",
      content: "GET /files",
      folder_path: "/specs/api",
    });
    expect(byPath).toMatchObject({
      parent_id: folder.id,
      name: "endpoints.md",
      path: "/specs/api/endpoints.md",
      version: 1,
    });
    const byId = await ok<File>(alex, "create_document", {
      name: "auth.md",
      content: "OAuth",
      parent_id: folder.id,
    });
    expect(byId.path).toBe("/specs/api/auth.md");

    // The same name in another folder is fine; in the same folder it isn't.
    await ok(alex, "create_document", { name: "endpoints.md", content: "root" });
    const dupe = await call(alex, "create_document", {
      name: "ENDPOINTS.md",
      content: "x",
      folder_path: "specs/api",
    });
    expect(dupe.structuredContent).toMatchObject({
      error: { code: "NAME_EXISTS", kind: "file", file_id: byPath.id },
    });
    // Files and folders share one namespace per folder.
    const clash = await call(alex, "create_document", { name: "Specs", content: "x" });
    expect(clash.structuredContent).toMatchObject({
      error: { code: "NAME_EXISTS", kind: "folder", name: "specs" },
    });

    const read = await ok<{ file: File; content: string }>(sam, "read_file", {
      path: "SPECS/api/endpoints.md",
    });
    expect(read).toMatchObject({
      file: { id: byPath.id, path: "/specs/api/endpoints.md" },
      content: "GET /files",
    });
    const byFileId = await ok<{ file: File }>(sam, "read_file", { file_id: byPath.id });
    expect(byFileId.file.path).toBe("/specs/api/endpoints.md");

    const search = await ok<{ results: { file: File }[] }>(sam, "search_files", {
      query: "OAuth",
    });
    expect(search.results.map((r) => r.file.path)).toEqual(["/specs/api/auth.md"]);

    for (const [args, code] of [
      [{ path: "/specs/api/missing.md" }, "PATH_NOT_FOUND"],
      [{ path: "/specs/api" }, "PATH_NOT_FOUND"],
      [{ path: "/specs//api" }, "INVALID_PATH"],
      [{}, "INVALID_INPUT"],
      [{ file_id: byPath.id, path: "/specs/api/endpoints.md" }, "INVALID_INPUT"],
    ] as const) {
      expect(errorCode(await call(sam, "read_file", args))).toBe(code);
    }

    for (const [args, code] of [
      [{ folder_path: "/drafts" }, "PATH_NOT_FOUND"],
      [{ folder_path: "/specs/api/endpoints.md" }, "PATH_NOT_FOUND"],
      [{ parent_id: "folder_missing" }, "FOLDER_NOT_FOUND"],
      [{ parent_id: folder.id, folder_path: "/specs" }, "INVALID_INPUT"],
    ] as const) {
      const result = await call(alex, "create_document", {
        name: "new.md",
        content: "x",
        ...args,
      });
      expect(errorCode(result)).toBe(code);
    }
    expect(
      text(await call(alex, "create_document", { name: "new.md", content: "x", folder_path: "/drafts" })),
    ).toContain("create_folder");
    const slash = await call(alex, "create_document", { name: "a/b.md", content: "x" });
    expect(errorCode(slash)).toBe("INVALID_INPUT");
    expect(text(slash)).toContain("folder_path");
    await Promise.all([alex.close(), sam.close()]);
  });

  it("hides other workspaces' folders behind FOLDER_NOT_FOUND", async () => {
    const alex = await connect("alex-token");
    const jordan = await connect("jordan-token");
    const { folder } = await mkdir(alex, "/private");
    for (const [name, args] of [
      ["list_files", { folder_id: folder.id }],
      ["create_document", { name: "x.md", content: "x", parent_id: folder.id }],
      ["move_folder", { folder_id: folder.id, expected_revision: 1, to_folder_path: "/" }],
    ] as const) {
      const result = await call(jordan, name, args);
      expect(result.structuredContent).toEqual({
        error: {
          code: "FOLDER_NOT_FOUND",
          message: expect.not.stringContaining("ws_demo"),
          folder_id: folder.id,
        },
      });
    }
    // A path resolves in the caller's own workspace only.
    expect(errorCode(await call(jordan, "list_files", { path: "/private" }))).toBe(
      "PATH_NOT_FOUND",
    );
    await Promise.all([alex.close(), jordan.close()]);
  });

  it("list_files lists one folder, a flattened subtree, or name matches within it", async () => {
    const alex = await connect("alex-token");
    const { folder: api } = await mkdir(alex, "/specs/api");
    await mkdir(alex, "/specs/ui");
    await mkdir(alex, "/archive");
    await ok(alex, "create_document", { name: "readme.md", content: "x", folder_path: "/specs" });
    await ok(alex, "create_document", { name: "api-notes.md", content: "x", folder_path: "/specs/api" });
    await ok(alex, "create_document", { name: "old-api.md", content: "x", folder_path: "/archive" });

    const specs = await ok<Listing>(alex, "list_files", { path: "/specs" });
    expect(specs.folder).toEqual({ id: expect.any(String), path: "/specs" });
    expect(specs.folders.map((f) => f.name)).toEqual(["api", "ui"]);
    expect(specs.files.map((f) => f.path)).toEqual(["/specs/readme.md"]);
    expect(specs.truncated).toBe(false);

    const byId = await ok<Listing>(alex, "list_files", { folder_id: api.id });
    expect(byId.files.map((f) => f.path)).toEqual(["/specs/api/api-notes.md"]);

    const tree = await ok<Listing>(alex, "list_files", { path: "/specs", recursive: true });
    expect(tree.folders.map((f) => f.path)).toEqual(["/specs/api", "/specs/ui"]);
    expect(tree.files.map((f) => f.path)).toEqual([
      "/specs/api/api-notes.md",
      "/specs/readme.md",
    ]);
    const everything = await ok<Listing>(alex, "list_files", { recursive: true });
    expect(everything.folders.map((f) => f.path)).toEqual([
      "/archive",
      "/specs",
      "/specs/api",
      "/specs/ui",
    ]);
    expect(everything.files).toHaveLength(4);

    const scoped = await ok<Listing>(alex, "list_files", { path: "/specs", query: "api" });
    expect(scoped.folders.map((f) => f.path)).toEqual(["/specs/api"]);
    expect(scoped.files.map((f) => f.path)).toEqual(["/specs/api/api-notes.md"]);
    const all = await ok<Listing>(alex, "list_files", { query: "api" });
    expect(all.files.map((f) => f.path)).toEqual([
      "/archive/old-api.md",
      "/specs/api/api-notes.md",
    ]);

    expect(errorCode(await call(alex, "list_files", { path: "/nope" }))).toBe("PATH_NOT_FOUND");
    expect(
      errorCode(await call(alex, "list_files", { folder_id: api.id, path: "/specs" })),
    ).toBe("INVALID_INPUT");
    await alex.close();
  });

  it("move_file moves and renames as a new version, and rejects stale versions and collisions", async () => {
    const alex = await connect("alex-token");
    const sam = await connect("sam-token");
    const { folder: archive } = await mkdir(alex, "/archive");
    const draft = await ok<File>(alex, "create_document", { name: "draft.md", content: "body" });
    await ok(alex, "create_document", { name: "draft.md", content: "taken", folder_path: "/archive" });
    const start = await ok<{ cursor: string }>(alex, "sync_workspace", {});

    // Sam edits first, so Alex's version is stale.
    await ok(sam, "update_document", { file_id: draft.id, content: "body v2", expected_version: 1 });
    const stale = await call(alex, "move_file", {
      file_id: draft.id,
      expected_version: 1,
      to_folder_path: "/archive",
      new_name: "plan.md",
    });
    expect(stale.structuredContent).toMatchObject({
      error: { code: "VERSION_CONFLICT", current_version: 2, expected_version: 1 },
    });
    expect(text(stale)).toContain("retry move_file with expected_version=2");

    const collision = await call(alex, "move_file", {
      file_id: draft.id,
      expected_version: 2,
      to_folder_id: archive.id,
    });
    expect(collision.structuredContent).toMatchObject({
      error: { code: "NAME_EXISTS", kind: "file", name: "draft.md" },
    });
    expect(errorCode(await call(alex, "move_file", { file_id: draft.id, expected_version: 2 }))).toBe(
      "INVALID_INPUT",
    );
    const unchanged = await ok<{ file: File }>(alex, "read_file", { file_id: draft.id });
    expect(unchanged.file).toMatchObject({ path: "/draft.md", version: 2 });

    const moved = await ok<File>(alex, "move_file", {
      file_id: draft.id,
      expected_version: 2,
      to_folder_path: "/archive",
      new_name: "plan.md",
    });
    expect(moved).toMatchObject({
      id: draft.id,
      parent_id: archive.id,
      name: "plan.md",
      path: "/archive/plan.md",
      version: 3,
    });
    const read = await ok<{ content: string }>(sam, "read_file", { path: "/archive/plan.md" });
    expect(read.content).toBe("body v2");
    const versions = await ok<{ versions: { version: number }[] }>(sam, "get_file_versions", {
      file_id: draft.id,
    });
    expect(versions.versions.map((v) => v.version)).toEqual([3, 2, 1]);

    const back = await ok<File>(alex, "move_file", {
      file_id: draft.id,
      expected_version: 3,
      to_folder_path: "/",
    });
    expect(back).toMatchObject({ parent_id: null, path: "/plan.md", version: 4 });

    const changes = await ok<{
      changed_files: File[];
      events: { type: string; summary: string }[];
    }>(alex, "sync_workspace", { since: start.cursor });
    expect(changes.changed_files).toEqual([
      expect.objectContaining({ id: draft.id, path: "/plan.md", version: 4 }),
    ]);
    expect(changes.events.filter((e) => e.type === "file.moved").map((e) => e.summary)).toEqual([
      "Moved draft.md to /archive as plan.md",
      "Moved plan.md to /",
    ]);
    await Promise.all([alex.close(), sam.close()]);
  });

  it("move_folder moves a subtree and rejects cycles, stale revisions, collisions and depth overflow", async () => {
    const alex = await connect("alex-token");
    const { folder: specs } = await mkdir(alex, "/specs");
    const { folder: api } = await mkdir(alex, "/specs/api");
    const { folder: archive } = await mkdir(alex, "/archive");
    await ok(alex, "create_document", { name: "endpoints.md", content: "x", folder_path: "/specs/api" });

    for (const to_folder_id of [specs.id, api.id]) {
      const cycle = await call(alex, "move_folder", {
        folder_id: specs.id,
        expected_revision: 1,
        to_folder_id,
      });
      expect(errorCode(cycle)).toBe("INVALID_MOVE");
    }
    expect(
      errorCode(
        await call(alex, "move_folder", {
          folder_id: specs.id,
          expected_revision: 1,
          to_folder_path: "/specs/api",
        }),
      ),
    ).toBe("INVALID_MOVE");

    await mkdir(alex, "/archive/specs");
    const collision = await call(alex, "move_folder", {
      folder_id: specs.id,
      expected_revision: 1,
      to_folder_id: archive.id,
    });
    expect(collision.structuredContent).toMatchObject({
      error: { code: "NAME_EXISTS", kind: "folder", name: "specs" },
    });

    const moved = await ok<Folder>(alex, "move_folder", {
      folder_id: specs.id,
      expected_revision: 1,
      to_folder_path: "/archive",
      new_name: "specs-2025",
    });
    expect(moved).toMatchObject({
      id: specs.id,
      parent_id: archive.id,
      name: "specs-2025",
      path: "/archive/specs-2025",
      revision: 2,
    });
    const file = await ok<{ file: File }>(alex, "read_file", {
      path: "/archive/specs-2025/api/endpoints.md",
    });
    expect(file.file.version).toBe(1);
    const sub = await ok<Listing>(alex, "list_files", { folder_id: api.id });
    expect(sub.folder.path).toBe("/archive/specs-2025/api");

    const stale = await call(alex, "move_folder", {
      folder_id: specs.id,
      expected_revision: 1,
      to_folder_path: "/",
    });
    expect(stale.structuredContent).toMatchObject({
      error: { code: "VERSION_CONFLICT", current_revision: 2, expected_revision: 1 },
    });

    // 31 levels down to the destination plus the two-level specs subtree is 33.
    const deep = `/deep/${Array.from({ length: 30 }, (_, i) => `d${i}`).join("/")}`;
    await mkdir(alex, deep);
    const tooDeep = await call(alex, "move_folder", {
      folder_id: specs.id,
      expected_revision: 2,
      to_folder_path: deep,
    });
    expect(errorCode(tooDeep)).toBe("FOLDER_TOO_DEEP");
    const events = await ok<{ events: { type: string; summary: string }[] }>(
      alex,
      "sync_workspace",
      {},
    );
    expect(events.events.filter((e) => e.type === "folder.moved").map((e) => e.summary)).toEqual([
      "Moved folder specs to /archive as specs-2025",
    ]);
    await alex.close();
  });

  describe("parity with Convex (PR #47 review)", () => {
    const paths = (r: Listing) => ({
      folders: r.folders.map((f) => f.path),
      files: r.files.map((f) => f.path),
    });

    it("list_files query: every term is a substring of the name, for files and folders alike", async () => {
      const alex = await connect("alex-token");
      await mkdir(alex, "/myspecs-dir");
      await mkdir(alex, "/archive/Spec Notes");
      await ok(alex, "create_document", { name: "myspecs.md", content: "x" });
      await ok(alex, "create_document", { name: "specs-v2.md", content: "x" });
      await ok(alex, "create_document", { name: "readme.md", content: "x", folder_path: "/archive" });
      const list = async (args: Record<string, unknown>) =>
        paths(await ok<Listing>(alex, "list_files", args));

      expect(await list({ query: "spec" })).toEqual({
        folders: ["/archive/Spec Notes", "/myspecs-dir"],
        files: ["/myspecs.md", "/specs-v2.md"],
      });
      expect(await list({ query: "  v2   specs " })).toEqual({ folders: [], files: ["/specs-v2.md"] });
      expect(await list({ query: "notes spec" })).toEqual({ folders: ["/archive/Spec Notes"], files: [] });
      expect(await list({ query: "brief " })).toEqual({ folders: [], files: ["/brief.md"] });
      // A blank query is no query: the root's immediate children.
      const root = {
        folders: ["/archive", "/myspecs-dir"],
        files: ["/brief.md", "/myspecs.md", "/specs-v2.md"],
      };
      expect(await list({ query: "" })).toEqual(root);
      expect(await list({ query: "   " })).toEqual(root);

      const blank = await call(alex, "search_files", { query: "   " });
      expect(blank.structuredContent).toMatchObject({
        error: { code: "INVALID_INPUT", field: "query" },
      });
      await alex.close();
    });

    it("sync since a folder move lists the files below it with their new paths", async () => {
      const alex = await connect("alex-token");
      const { folder: specs } = await mkdir(alex, "/specs/api");
      await ok(alex, "create_document", { name: "endpoints.md", content: "x", folder_path: "/specs/api" });
      await mkdir(alex, "/archive");
      const start = await ok<{ cursor: string }>(alex, "sync_workspace", {});
      await ok(alex, "move_folder", {
        folder_id: specs.id,
        expected_revision: 1,
        to_folder_path: "/archive",
      });
      const delta = await ok<{
        changed_files: File[];
        files_truncated: boolean;
        events: { type: string }[];
      }>(alex, "sync_workspace", { since: start.cursor });
      expect(delta.events.map((e) => e.type)).toEqual(["folder.moved"]);
      expect(delta.changed_files.map((f) => f.path)).toEqual(["/archive/api/endpoints.md"]);
      expect(delta.files_truncated).toBe(false);
      await alex.close();
    });

    it("no-op moves change nothing: no new version, revision or event", async () => {
      const alex = await connect("alex-token");
      const { folder } = await mkdir(alex, "/specs");
      const file = await ok<File>(alex, "create_document", { name: "plan.md", content: "x", folder_path: "/specs" });
      const start = await ok<{ cursor: string }>(alex, "sync_workspace", {});

      const same = await ok<File>(alex, "move_file", { file_id: file.id, expected_version: 1, to_folder_path: "/specs" });
      expect(same.version).toBe(1);
      const sameName = await ok<File>(alex, "move_file", {
        file_id: file.id,
        expected_version: 1,
        to_folder_id: folder.id,
        new_name: " plan.md ",
      });
      expect(sameName.version).toBe(1);
      const sameFolder = await ok<Folder>(alex, "move_folder", {
        folder_id: folder.id,
        expected_revision: 1,
        to_folder_path: "/",
      });
      expect(sameFolder.revision).toBe(1);
      const delta = await ok<{ events: unknown[] }>(alex, "sync_workspace", { since: start.cursor });
      expect(delta.events).toEqual([]);
      const versions = await ok<{ versions: unknown[] }>(alex, "get_file_versions", { file_id: file.id });
      expect(versions.versions).toHaveLength(1);
      // A case-only rename is a real move.
      const recased = await ok<File>(alex, "move_file", {
        file_id: file.id,
        expected_version: 1,
        to_folder_path: "/specs",
        new_name: "Plan.md",
      });
      expect(recased).toMatchObject({ version: 2, name: "Plan.md" });
      await alex.close();
    });

    it("reports path, depth and version problems with Convex's codes and order", async () => {
      const alex = await connect("alex-token");
      const { folder } = await mkdir(alex, "/f");
      const code = async (name: string, args: Record<string, unknown>) =>
        errorCode(await call(alex, name, args));

      for (const path of ["", "/a/​./b", "/a//b"]) {
        expect(await code("read_file", { path })).toBe("INVALID_PATH");
        expect(await code("create_folder", { path })).toBe("INVALID_PATH");
        expect(await code("list_files", { path })).toBe("INVALID_PATH");
        expect(await code("create_document", { name: "x.md", content: "", folder_path: path })).toBe("INVALID_PATH");
        expect(await code("move_file", { file_id: "file_brief", expected_version: 1, to_folder_path: path })).toBe(
          "INVALID_PATH",
        );
        expect(await code("move_folder", { folder_id: folder.id, expected_revision: 1, to_folder_path: path })).toBe(
          "INVALID_PATH",
        );
      }
      const deep = (n: number) => "/" + Array.from({ length: n }, (_, i) => `d${i}`).join("/");
      expect(await code("create_folder", { path: deep(33) })).toBe("FOLDER_TOO_DEEP");
      expect(await code("create_folder", { path: deep(34) })).toBe("FOLDER_TOO_DEEP");
      expect(await code("read_file", { path: deep(34) })).toBe("FOLDER_TOO_DEEP");
      expect(await code("list_files", { path: deep(40) })).toBe("FOLDER_TOO_DEEP");
      expect(await code("read_file", { path: deep(33) })).toBe("PATH_NOT_FOUND");

      expect(await code("move_file", { file_id: "file_brief", expected_version: 9, to_folder_path: "/f" })).toBe(
        "VERSION_CONFLICT",
      );
      expect(await code("move_folder", { folder_id: folder.id, expected_revision: 9, to_folder_path: "/" })).toBe(
        "VERSION_CONFLICT",
      );
      // The destination is resolved before the version is checked.
      expect(await code("move_file", { file_id: "file_brief", expected_version: 9, to_folder_path: "/nope" })).toBe(
        "PATH_NOT_FOUND",
      );
      await alex.close();
    });

    it("sends Convex's error details and tool-specific recovery hints", async () => {
      const alex = await connect("alex-token");
      const { folder: a } = await mkdir(alex, "/a");
      await mkdir(alex, "/a/b");
      const errorOf = async (name: string, args: Record<string, unknown>) =>
        (await call(alex, name, args)).structuredContent as { error: Record<string, unknown> };

      const { error: tooDeep } = await errorOf("create_folder", {
        path: "/" + Array.from({ length: 33 }, (_, i) => `d${i}`).join("/"),
      });
      expect(tooDeep).toEqual({ code: "FOLDER_TOO_DEEP", message: expect.any(String), max_depth: 32 });
      const { error: cycle } = await errorOf("move_folder", {
        folder_id: a.id,
        expected_revision: 1,
        to_folder_path: "/a/b",
      });
      expect(cycle).toEqual({ code: "INVALID_MOVE", message: expect.any(String), folder_id: a.id });

      const { error: badName } = await errorOf("create_document", { name: "a/b.md", content: "" });
      expect(badName).toMatchObject({ code: "INVALID_INPUT", field: "name" });
      expect(badName.message).toMatch(/pass folder_path/);
      const { error: badNewName } = await errorOf("move_file", {
        file_id: "file_brief",
        expected_version: 1,
        to_folder_path: "/",
        new_name: "x/y.md",
      });
      expect(badNewName).toMatchObject({ code: "INVALID_INPUT", field: "name" });
      expect(badNewName.message).toMatch(/to_folder_path/);
      expect(badNewName.message).not.toMatch(/pass folder_path/);

      const { error: throughFile } = await errorOf("create_folder", { path: "/brief.md/sub" });
      expect(throughFile).toMatchObject({ code: "NAME_EXISTS", kind: "file" });
      expect(throughFile.message).not.toMatch(/update_document/);
      await ok(alex, "create_document", { name: "taken.md", content: "", folder_path: "/a" });
      const { error: moveClash } = await errorOf("move_file", {
        file_id: "file_brief",
        expected_version: 1,
        to_folder_path: "/a",
        new_name: "TAKEN.md",
      });
      expect(moveClash).toMatchObject({ code: "NAME_EXISTS", kind: "file" });
      expect(moveClash.message).toMatch(/new_name/);
      expect(moveClash.message).not.toMatch(/update_document/);
      await alex.close();
    });
  });
});

describe("Origin allowlist", () => {
  let originServer: Server;
  let originUrl: URL;

  beforeEach(async () => {
    originServer = createApp({
      backend: new MockBackend(),
      identity: new DevTokenResolver(DEV_TOKENS),
      allowedOrigins: ["http://localhost:6274"],
    });
    originUrl = new URL("/mcp", await listen(originServer));
  });

  afterEach(() => stop(originServer));

  it("rejects origins that aren't listed", async () => {
    for (const origin of [
      "http://evil.example",
      "http://localhost:6274.evil.example",
      "null",
    ]) {
      const res = await post(originUrl, {
        "api-key": "alex-token",
        Origin: origin,
      });
      expect(res.status).toBe(403);
    }
  });

  it("accepts listed origins and requests without Origin", async () => {
    for (const headers of [
      { "api-key": "alex-token", Origin: "http://localhost:6274" },
      { "api-key": "alex-token" },
    ]) {
      const client = new Client({ name: "test", version: "0.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(originUrl, {
          requestInit: { headers },
        }),
      );
      const { tools } = await client.listTools();
      expect(tools.length).toBe(14);
      await client.close();
    }
  });

  it("normalizes configured origins and warns about invalid ones", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        parseAllowedOrigins(
          " http://localhost:6274/ ,HTTP://Example.com:443/path,,not a url,localhost:6274",
        ),
      ).toEqual(["http://localhost:6274", "http://example.com:443"]);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }

    // A trailing slash in the config no longer blocks the browser's origin.
    const slashServer = createApp({
      backend: new MockBackend(),
      identity: new DevTokenResolver(DEV_TOKENS),
      allowedOrigins: parseAllowedOrigins("http://localhost:6274/"),
    });
    try {
      const url = new URL("/mcp", await listen(slashServer));
      const client = new Client({ name: "test", version: "0.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: {
            headers: {
              "api-key": "alex-token",
              Origin: "http://localhost:6274",
            },
          },
        }),
      );
      const { tools } = await client.listTools();
      expect(tools.length).toBe(14);
      await client.close();
    } finally {
      await stop(slashServer);
    }
  });
});

describe("MockBackend", () => {
  const alex: Actor = {
    user_id: "user_alex",
    client: "test",
    actor_type: "agent",
  };

  async function expectCode(promise: Promise<unknown>, code: string) {
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TandemError);
    expect((err as TandemError).code).toBe(code);
  }

  it("rejects invalid expected_version as INVALID_INPUT without writing", async () => {
    const backend = new MockBackend();
    for (const expected_version of [NaN, 0, -1, 0.5, Infinity]) {
      await expectCode(
        backend.updateDocument(alex, {
          file_id: "file_brief",
          content: "bad",
          expected_version,
        }),
        "INVALID_INPUT",
      );
    }
    const { file } = await backend.readFile(alex, { file_id: "file_brief" });
    expect(file.version).toBe(1);
  });

  it("rejects names whose normalized key is empty", async () => {
    const backend = new MockBackend();
    for (const name of ["   ", "\u200B", "\uFEFF \u2060"]) {
      await expectCode(
        backend.createDocument(alex, {
          name,
          content: "x",
          mime_type: "text/plain",
        }),
        "INVALID_INPUT",
      );
    }
  });

  it("normalizes name keys", () => {
    expect(nameKey("  My\u00A0 Caf\u00e9.MD\u200B ")).toBe("my caf\u00e9.md");
    expect(nameKey("cafe\u0301.md")).toBe(nameKey("caf\u00e9.md"));
    expect(nameKey("Stra\u00dfe.md")).toBe(nameKey("STRASSE.md"));
  });

  it("accepts only valid new names", () => {
    for (const name of ["notes.md", "a.b", "...", "x".repeat(255)])
      expect(isValidName(name), name).toBe(true);
    for (const name of ["", " ", "a/b", ".", "..", "x".repeat(256)])
      expect(isValidName(name), name).toBe(false);
  });

  it("stores the display form of a name", () => {
    expect(storedName(" \u200bcafe\u0301.MD\ufeff ")).toBe("caf\u00e9.MD");
  });
});

describe("DevTokenResolver", () => {
  it("splits entries on the first colon and trims both halves", async () => {
    const tokens = new DevTokenResolver(" k1 : user:a , k2:user_b");
    expect(await tokens.resolve("k1")).toEqual({
      user_id: "user:a",
      client: "dev-token",
    });
    expect(await tokens.resolve("k2")).toMatchObject({ user_id: "user_b" });
    expect(tokens.size).toBe(2);
  });

  it("warns about malformed entries", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tokens = new DevTokenResolver("nocolon,:user_x,k:,good:user_g");
      expect(tokens.size).toBe(1);
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("dev anon mode", () => {
  let anonServer: Server;
  let anonUrl: URL;

  beforeEach(async () => {
    const backend = new MockBackend();
    anonServer = createApp({
      backend,
      identity: withDevAnon(
        new DevTokenResolver(DEV_TOKENS),
        { TANDEM_DEV_ANON_USER: "user_alex", NODE_ENV: "test" },
        backend,
      ),
    });
    anonUrl = new URL("/mcp", await listen(anonServer));
  });

  afterEach(() => stop(anonServer));

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
    const mock = new MockBackend();
    expect(withDevAnon(tokens, {}, mock)).toBe(tokens);
    expect(withDevAnon(tokens, { TANDEM_DEV_ANON_USER: " " }, mock)).toBe(
      tokens,
    );
  });

  it("enables only with the mock backend and NODE_ENV development or test", () => {
    const tokens = new DevTokenResolver(DEV_TOKENS);
    const mock = new MockBackend();
    for (const NODE_ENV of ["development", "test"]) {
      expect(
        withDevAnon(
          tokens,
          { TANDEM_DEV_ANON_USER: "user_alex", NODE_ENV },
          mock,
        ),
      ).toBeInstanceOf(DevAnonResolver);
    }
  });

  it("refuses to enable outside mock dev", () => {
    const tokens = new DevTokenResolver(DEV_TOKENS);
    const mock = new MockBackend();
    for (const NODE_ENV of [
      undefined,
      "",
      "prod",
      "production",
      "Production",
      " development",
      "Development",
    ]) {
      expect(() =>
        withDevAnon(
          tokens,
          { TANDEM_DEV_ANON_USER: "user_alex", NODE_ENV },
          mock,
        ),
      ).toThrow(/TANDEM_DEV_ANON_USER/);
    }
    // Decided by the backend actually constructed, not by TANDEM_BACKEND.
    expect(() =>
      withDevAnon(
        tokens,
        {
          TANDEM_DEV_ANON_USER: "user_alex",
          NODE_ENV: "development",
          TANDEM_BACKEND: "mock",
        },
        { kind: "convex" },
      ),
    ).toThrow(/TANDEM_DEV_ANON_USER/);
  });
});
