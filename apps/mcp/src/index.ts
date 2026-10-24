import { DevAnonResolver, DevTokenResolver, withDevAnon } from "./auth.js";
import { createBackend } from "./backend/index.js";
import { createApp } from "./server.js";

const port = Number(process.env.PORT ?? 8787);
const backend = createBackend(process.env.TANDEM_BACKEND ?? "mock");
const tokens = new DevTokenResolver(process.env.TANDEM_DEV_TOKENS ?? "");
const identity = withDevAnon(tokens, process.env);

if (identity instanceof DevAnonResolver) {
  console.warn(
    `DEV ANON MODE: unauthenticated requests act as ${identity.userId}. Mock data only. Do not deploy.`,
  );
} else if (tokens.size === 0) {
  console.warn("TANDEM_DEV_TOKENS is empty: every /mcp request will get 401.");
}

createApp({ backend, identity }).listen(port, () => {
  console.log(`Tandem MCP server listening on http://localhost:${port}/mcp`);
});
