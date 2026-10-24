import { DevAnonResolver, DevTokenResolver, withDevAnon } from "./auth.js";
import { createBackend } from "./backend/index.js";
import { createApp, parseAllowedOrigins } from "./server.js";

// Mock-backed harness for the skill eval and local tool experiments. The
// deployed MCP server is @convex-dev/mcp in Convex (packages/backend/convex/mcp.ts).
const port = Number(process.env.PORT ?? 8787);
// Localhost only by default.
const host = process.env.HOST ?? "127.0.0.1";
const allowedOrigins = parseAllowedOrigins(
  process.env.TANDEM_ALLOWED_ORIGINS ?? "",
);
const backend = createBackend(process.env.TANDEM_BACKEND ?? "mock");

const tokens = new DevTokenResolver(process.env.TANDEM_DEV_TOKENS ?? "");
const identity = withDevAnon(tokens, process.env, backend);
if (identity instanceof DevAnonResolver) {
  console.warn(
    `DEV ANON MODE: unauthenticated requests act as ${identity.userId}. Mock data only. Do not deploy.`,
  );
} else if (tokens.size === 0) {
  console.warn("TANDEM_DEV_TOKENS is empty: every /mcp request will get 401.");
}

createApp({ backend, identity, allowedOrigins }).listen(port, host, () => {
  console.log(`Tandem MCP mock server listening on http://${host}:${port}/mcp`);
});
