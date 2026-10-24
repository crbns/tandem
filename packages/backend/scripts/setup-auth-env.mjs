// Generates Convex Auth signing keys and sets them on the current deployment
// without printing them. Run from packages/backend.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";

// The CLI's entry file through node, so this works on Windows too (npx is npx.cmd there).
const convexCli = fileURLToPath(new URL("../node_modules/convex/bin/main.js", import.meta.url));

const keys = await generateKeyPair("RS256", { extractable: true });
const privateKey = await exportPKCS8(keys.privateKey);
const publicKey = await exportJWK(keys.publicKey);
const jwks = JSON.stringify({ keys: [{ use: "sig", ...publicKey }] });

const set = (name, value) =>
  execFileSync(process.execPath, [convexCli, "env", "set", name, "--", value], {
    stdio: ["ignore", "ignore", "inherit"],
  });
set("JWT_PRIVATE_KEY", privateKey.trimEnd().replace(/\n/g, " "));
set("JWKS", jwks);
set("SITE_URL", process.env.SITE_URL ?? "http://localhost:3000");
console.log("Set JWT_PRIVATE_KEY, JWKS, SITE_URL");
