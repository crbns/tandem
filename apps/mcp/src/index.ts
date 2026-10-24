import { DevTokenResolver } from "./auth.js";
import { createBackend } from "./backend/index.js";
import { createApp } from "./server.js";

const port = Number(process.env.PORT ?? 8787);
const backend = createBackend(process.env.TANDEM_BACKEND ?? "mock");
const identity = new DevTokenResolver(process.env.TANDEM_DEV_TOKENS ?? "");

if (identity.size === 0) {
  console.warn("TANDEM_DEV_TOKENS is empty: every /mcp request will get 401.");
}

createApp({ backend, identity }).listen(port, () => {
  console.log(`Tandem MCP server listening on http://localhost:${port}/mcp`);
});
