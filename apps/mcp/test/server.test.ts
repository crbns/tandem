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
import type { Actor } from "../src/backend/types.js";
import { TandemError } from "../src/errors.js";
import { nameKey } from "../src/names.js";
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
    await client.close();
  });

  it("treats Unicode and whitespace variants of a name as duplicates", async () => {
    const client = await connect("alex-token");
    for (const [first, second] of [
      ["caf\u00e9.md", "cafe\u0301.md"], // NFC vs NFD
      ["zw.md", "zw.md\u200B"], // trailing zero-width space
      ["my notes.md", "my  notes.md"], // double internal space
      ["\ufb01le.md", "file.md"], // NFKC ligature
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
      expect(tools.length).toBe(4);
      await client.close();
    }
  });
});

describe("MockBackend", () => {
  const alex: Actor = { user_id: "user_alex", client: "test" };

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
    const { file } = await backend.readFile(alex, "file_brief");
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
