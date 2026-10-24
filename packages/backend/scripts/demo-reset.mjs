// Resets the demo (issue #22): rebuilds the "Onboarding refresh" workspace for
// Alex, Blake and Casey through the internal seed:resetDemo function, then
// prints sign-in credentials and agent tokens. Only the demo workspace is
// touched. Uses the deployment `npx convex run` targets (.env.local, or
// CONVEX_DEPLOY_KEY); extra arguments such as --prod are passed through.
//
//   node scripts/demo-reset.mjs [--json] [convex run flags...]
//
// DEMO_PASSWORD and DEMO_TOKEN_ALEX / _BLAKE / _CASEY keep the password and
// tokens stable across resets (otherwise new ones are generated each time).
// TANDEM_WEB_URL and TANDEM_MCP_URL only change what's printed.
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

const stdout = execFileSync(
  `${backendDir}node_modules/.bin/convex`,
  ["run", "seed:resetDemo", JSON.stringify(args), ...passthrough],
  { cwd: backendDir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);
const demo = JSON.parse(stdout.slice(stdout.indexOf("{")));

if (json) {
  console.log(JSON.stringify(demo, null, 2));
  process.exit(0);
}

const webUrl = process.env.TANDEM_WEB_URL ?? "http://localhost:3000";
const mcpUrl = process.env.TANDEM_MCP_URL ?? "http://127.0.0.1:8787/mcp";
const lines = [
  `Demo reset: workspace "${demo.workspaceName}" (${demo.workspaceId})`,
  `Dashboard: ${webUrl}/w/${demo.workspaceId}`,
  `Password (all three): ${demo.password}`,
  "",
];
for (const member of demo.members) {
  lines.push(
    `${member.name} (${member.role}): ${member.email}`,
    `  ${member.client} token: ${member.token}`,
  );
  // Claude Code can send the token as a header; other clients need OAuth (#21).
  if (member.client === "claude")
    lines.push(
      `  claude mcp add --transport http tandem ${mcpUrl} --header "Authorization: Bearer ${member.token}"`,
    );
}
lines.push(
  "",
  "To keep these across resets:",
  `  DEMO_PASSWORD='${demo.password}' ${demo.members
    .map((m) => `DEMO_TOKEN_${m.key.toUpperCase()}=${m.token}`)
    .join(" ")}`,
);
console.log(lines.join("\n"));
