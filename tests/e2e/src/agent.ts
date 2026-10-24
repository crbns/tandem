// An assistant as a native client sees Tandem: the official MCP TypeScript SDK
// over Streamable HTTP, authenticated with an agent connection token.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface ToolError {
  code: string;
  message: string;
  [key: string]: unknown;
}

export type ToolOutcome<T> = { ok: true; data: T } | { ok: false; error: ToolError };

export class Agent {
  private constructor(readonly client: Client) {}

  static async connect(mcpUrl: string, token: string): Promise<Agent> {
    const client = new Client({ name: "tandem-e2e", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    return new Agent(client);
  }

  /** Calls a tool and returns its JSON result or its coded error. */
  async call<T = Record<string, unknown>>(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<ToolOutcome<T>> {
    const result = await this.client.callTool({ name, arguments: args });
    const structured = result.structuredContent as Record<string, unknown> | undefined;
    if (result.isError) {
      const error = structured?.error as ToolError | undefined;
      if (!error) {
        const text = (result.content as { text?: string }[] | undefined)?.[0]?.text;
        throw new Error(`${name} failed without a coded error: ${text}`);
      }
      return { ok: false, error };
    }
    return { ok: true, data: structured as T };
  }

  /** Calls a tool that must succeed. */
  async ok<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const outcome = await this.call<T>(name, args);
    if (!outcome.ok) throw new Error(`${name} failed: ${JSON.stringify(outcome.error)}`);
    return outcome.data;
  }

  /** Calls a tool that must fail with a coded error. */
  async fails(name: string, args: Record<string, unknown> = {}): Promise<ToolError> {
    const outcome = await this.call(name, args);
    if (outcome.ok) throw new Error(`${name} unexpectedly succeeded: ${JSON.stringify(outcome.data)}`);
    return outcome.error;
  }

  close() {
    return this.client.close();
  }
}

/** A bare JSON-RPC POST, to see the HTTP status the transport would get. */
export async function rawMcpStatus(
  mcpUrl: string,
  headers: Record<string, string>,
): Promise<{ status: number; wwwAuthenticate: string | null }> {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  await res.body?.cancel();
  return { status: res.status, wwwAuthenticate: res.headers.get("www-authenticate") };
}
