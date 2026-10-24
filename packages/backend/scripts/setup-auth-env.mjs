// Generates Convex Auth signing keys and sets them, plus SITE_URL, on a
// deployment without printing them. Run from packages/backend.
//
//   node scripts/setup-auth-env.mjs                       # deployment in .env.local
//   SITE_URL=https://app.example.com node scripts/setup-auth-env.mjs --prod
//   SITE_URL=https://app.example.com node scripts/setup-auth-env.mjs --deployment <name>
//
// With CONVEX_DEPLOY_KEY set, the Convex CLI targets that key's deployment.
// Rerunning rotates the keys and signs everyone out of that deployment.
import { execFileSync } from "node:child_process";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";

const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const args = process.argv.slice(2);
const target = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--prod") target.push("--prod");
  else if (args[i] === "--deployment" && args[i + 1] && !args[i + 1].startsWith("-"))
    target.push("--deployment", args[++i]);
  else fail(`Unknown or incomplete argument ${JSON.stringify(args[i])}. Use --prod or --deployment <name>.`);
}
// One target only: the CLI would otherwise pick one silently (and --deployment
// overrides CONVEX_DEPLOY_KEY).
if (target.filter((a) => a.startsWith("--")).length > 1) fail("Pass --prod or --deployment, not both.");
if (target.length > 0 && process.env.CONVEX_DEPLOY_KEY)
  fail("CONVEX_DEPLOY_KEY already selects a deployment; drop --prod/--deployment.");

// A non-default target is a hosted deployment: never let it fall back to localhost.
const remote = target.length > 0 || Boolean(process.env.CONVEX_DEPLOY_KEY);
const siteUrl = process.env.SITE_URL ?? (remote ? undefined : "http://localhost:3000");
if (!siteUrl) fail("Set SITE_URL to the dashboard's public URL, e.g. SITE_URL=https://app.example.com.");

const keys = await generateKeyPair("RS256", { extractable: true });
const privateKey = await exportPKCS8(keys.privateKey);
const publicKey = await exportJWK(keys.publicKey);
const jwks = JSON.stringify({ keys: [{ use: "sig", ...publicKey }] });

const set = (name, value) =>
  execFileSync("npx", ["convex", "env", "set", ...target, name, "--", value], {
    stdio: ["ignore", "ignore", "inherit"],
  });
set("JWT_PRIVATE_KEY", privateKey.trimEnd().replace(/\n/g, " "));
set("JWKS", jwks);
set("SITE_URL", siteUrl);
console.log(`Set JWT_PRIVATE_KEY, JWKS, SITE_URL=${siteUrl}${target.length ? ` (${target.join(" ")})` : ""}`);
