import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevTokenResolver, withDevAnon } from "../src/auth.js";
import { MockBackend } from "../src/backend/mock.js";
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

  it("lists exactly the four file tools", async () => {
    const client = await connect("alex-token");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "create_document",
      "list_files",
      "read_file",
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
    expect(annotations).toEqual({
      list_files: { readOnlyHint: true, openWorldHint: false },
      read_file: { readOnlyHint: true, openWorldHint: false },
      create_document: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      update_document: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
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
