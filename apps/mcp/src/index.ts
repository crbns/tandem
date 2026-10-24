import {
  ConvexTokenResolver,
  DevAnonResolver,
  DevTokenResolver,
  withDevAnon,
  type IdentityResolver,
} from "./auth.js";
import { createBackend } from "./backend/index.js";
import { ConvexBackend } from "./backend/convex.js";
import { createApp, parseAllowedOrigins } from "./server.js";

const port = Number(process.env.PORT ?? 8787);
// Localhost only by default; set HOST=0.0.0.0 inside a container.
const host = process.env.HOST ?? "127.0.0.1";
const allowedOrigins = parseAllowedOrigins(
  process.env.TANDEM_ALLOWED_ORIGINS ?? "",
);
const backend = createBackend(process.env.TANDEM_BACKEND ?? "mock", process.env);

let identity: IdentityResolver;
if (backend instanceof ConvexBackend) {
  // Convex is the identity authority; dev tokens and anon mode don't apply.
  // withDevAnon still runs so TANDEM_DEV_ANON_USER fails closed here.
  identity = withDevAnon(new ConvexTokenResolver(backend), process.env, backend);
  console.log(`Tandem MCP using Convex at ${process.env.CONVEX_URL}`);
} else {
  const tokens = new DevTokenResolver(process.env.TANDEM_DEV_TOKENS ?? "");
  identity = withDevAnon(tokens, process.env, backend);
  if (identity instanceof DevAnonResolver) {
    console.warn(
      `DEV ANON MODE: unauthenticated requests act as ${identity.userId}. Mock data only. Do not deploy.`,
    );
  } else if (tokens.size === 0) {
    console.warn("TANDEM_DEV_TOKENS is empty: every /mcp request will get 401.");
  }
}

createApp({
  backend,
  identity,
  allowedOrigins,
  acceptBearer: backend.kind === "convex",
}).listen(port, host, () => {
  console.log(`Tandem MCP server listening on http://${host}:${port}/mcp`);
});
