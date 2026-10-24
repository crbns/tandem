// Local dev helper: signs up (or signs in) a Password user on the deployment in
// CONVEX_URL, makes sure they have a workspace, and prints a fresh API key for
// the deployment's MCP endpoint (<CONVEX_SITE_URL>/mcp). Never point this at
// production.
//
//   CONVEX_URL=http://127.0.0.1:3210 node scripts/dev-agent-token.mjs \
//     [email] [password] [client]
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const url = process.env.CONVEX_URL ?? "http://127.0.0.1:3210";
const [email = "dev@example.com", password = "dev-password-123", client = "claude"] =
  process.argv.slice(2);

const convex = new ConvexHttpClient(url, { logger: false });
async function signIn(flow) {
  const result = await convex.action(anyApi.auth.signIn, {
    provider: "password",
    params: { email, password, flow },
  });
  return result?.tokens?.token;
}
let jwt;
try {
  jwt = await signIn("signIn");
} catch {
  jwt = await signIn("signUp");
}
if (!jwt) throw new Error("Sign-in returned no token");
convex.setAuth(jwt);

await convex.mutation(anyApi.workspaces.initializeUser, {});
let [workspace] = await convex.query(anyApi.workspaces.listWorkspaces, {});
if (!workspace) {
  const id = await convex.mutation(anyApi.workspaces.createWorkspace, {
    name: "Local dev workspace",
  });
  workspace = { id, name: "Local dev workspace" };
}
const connection = await convex.action(
  anyApi.agentConnections.createAgentConnection,
  { workspaceId: workspace.id, client, displayName: `Local ${client}` },
);
console.error(
  `workspace ${workspace.id} (${workspace.name}), connection ${connection.connectionId}, MCP ${connection.mcpUrl}`,
);
// The key alone on stdout, so `TOKEN=$(node scripts/dev-agent-token.mjs)` works.
console.log(connection.token);
