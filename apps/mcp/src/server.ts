import { createServer, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { bearerToken, type IdentityResolver } from "./auth.js";
import type { TandemBackend } from "./backend/types.js";
import { createMcpServer } from "./tools.js";

export interface AppOptions {
  backend: TandemBackend;
  identity: IdentityResolver;
}

export function createApp({ backend, identity }: AppOptions): Server {
  return createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url ?? "/", "http://localhost");

      if (pathname === "/healthz" && req.method === "GET") {
        return sendJson(res, 200, { ok: true });
      }
      if (pathname !== "/mcp") {
        return sendJson(res, 404, { error: "not_found" });
      }

      const token = bearerToken(req.headers.authorization);
      const actor = token ? await identity.resolve(token) : null;
      if (!actor) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="tandem"');
        return sendJson(res, 401, {
          error: {
            code: "UNAUTHENTICATED",
            message: "Missing or invalid bearer token.",
          },
        });
      }

      // Stateless mode: no sessions, so there is no standalone SSE stream (GET) or session to end (DELETE).
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return sendJson(res, 405, {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Method not allowed. This server is stateless; use POST.",
          },
          id: null,
        });
      }

      const server = createMcpServer(backend, actor);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("Request failed", err);
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
    }
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
