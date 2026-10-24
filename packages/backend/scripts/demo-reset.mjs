// Resets the demo (issue #22): rebuilds the "Onboarding refresh" workspace for
// Alex, Blake and Casey through the internal seed:resetDemo function, then
// prints sign-in credentials and MCP API keys. Only the demo workspace is
// touched. Uses the deployment `npx convex run` targets (.env.local, or
// CONVEX_DEPLOY_KEY); extra arguments such as --prod are passed through.
//
//   node scripts/demo-reset.mjs [--json] [convex run flags...]
//
// DEMO_PASSWORD and DEMO_TOKEN_ALEX / _BLAKE / _CASEY (mcp_sk_ API keys) keep
// the password and keys stable across resets (otherwise new ones are generated
// each time). TANDEM_WEB_URL and TANDEM_MCP_URL only change what's printed;
// the MCP URL defaults to the deployment's own <CONVEX_SITE_URL>/mcp.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const backendDir = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
const json = argv.includes("--json");
const passthrough = argv.filter((arg) => arg !== "--json");

const tokens = Object.fromEntries(
  ["alex", "blake", "casey"]
    .map((key) => [key, process.env[`DEMO_TOKEN_${key.toUpperCase()}`]])
    .filter(([, token]) => token),
);
const args = {
  ...(process.env.DEMO_PASSWORD ? { password: process.env.DEMO_PASSWORD } : {}),
  ...(Object.keys(tokens).length ? { tokens } : {}),
};

// Node runs the CLI's entry file directly: node_modules/.bin/convex is a shell
// shim that execFileSync can't start on Windows.
const stdout = execFileSync(
  process.execPath,
  [`${backendDir}node_modules/convex/bin/main.js`, "run", "seed:resetDemo", JSON.stringify(args), ...passthrough],
  { cwd: backendDir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);
const demo = JSON.parse(stdout.slice(stdout.indexOf("{")));

if (json) {
  console.log(JSON.stringify(demo, null, 2));
  process.exit(0);
}

const webUrl = process.env.TANDEM_WEB_URL ?? "http://localhost:3000";
const mcpUrl = process.env.TANDEM_MCP_URL ?? demo.mcpUrl;
const lines = [
  `Demo reset: workspace "${demo.workspaceName}" (${demo.workspaceId})`,
  `Dashboard: ${webUrl}/w/${demo.workspaceId}/overview`,
  `Password (all three): ${demo.password}`,
  `MCP server: ${mcpUrl} (claude.ai: add it as a custom connector and sign in)`,
  "",
];
for (const member of demo.members) {
  lines.push(
    `${member.name} (${member.role}): ${member.email}`,
    `  ${member.client} API key: ${member.token}`,
  );
  // Claude Code can send the key as a header; claude.ai signs in with OAuth.
  if (member.client === "claude")
    lines.push(
      `  claude mcp add --transport http tandem ${mcpUrl} --header "Authorization: Bearer ${member.token}"`,
    );
}
lines.push(
  "",
  "To keep these across resets:",
  `  DEMO_PASSWORD='${demo.password.replaceAll("'", "'\\''")}' ${demo.members
    .map((m) => `DEMO_TOKEN_${m.key.toUpperCase()}=${m.token}`)
    .join(" ")}`,
);
console.log(lines.join("\n"));
