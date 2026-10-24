# Deploy: Convex Cloud + one Vultr instance

Convex Cloud hosts the backend (database, auth, functions). One Vultr instance runs three containers from `deploy/compose.yml`: Caddy for HTTPS, the web dashboard (`apps/web`), and the MCP server (`apps/mcp`). Both app containers talk to Convex directly. Neither holds a Convex admin or deploy key at runtime.

```
browser ──https──▶ Caddy ─▶ web:3000 ──▶ Convex (<prod>.convex.cloud)
Claude  ──https──▶ Caddy ─▶ mcp:8787 ──▶ Convex   (Bearer tdm_ token, verified by Convex)
```

## 1. Convex production deployment

In the Convex dashboard, open the project and create a **production deploy key** (Settings → Deploy keys). Keep it out of the repo.

```sh
cd packages/backend
CONVEX_DEPLOY_KEY='<prod deploy key>' npx convex deploy
```

This pushes the schema and functions and prints the production URL, `https://<prod>.convex.cloud`.

Then set up sign-in on that deployment. `SITE_URL` is the dashboard's public URL:

```sh
CONVEX_DEPLOY_KEY='<prod deploy key>' SITE_URL=https://app.example.com node scripts/setup-auth-env.mjs
```

The script generates a fresh RS256 key pair and sets `JWT_PRIVATE_KEY`, `JWKS` and `SITE_URL` without printing the keys. With a deploy key, or with `--prod` or `--deployment <name>` (when you're logged in to the Convex CLI), it refuses to run without `SITE_URL`. Rerunning it rotates the keys and signs everyone out.

Redeploy functions with the same `npx convex deploy` command whenever `packages/backend/convex` changes.

## 2. Vultr instance

1. Create an instance with Docker installed. Building the Next.js image on the box needs about 4 GB RAM; 2 vCPU / 4 GB is comfortable.
2. Firewall: allow inbound 22, 80 and 443 (TCP), plus 443/UDP for HTTP/3. Nothing else: the app containers aren't published on the host.
3. DNS: point A records for two names at the instance IP, for example `app.example.com` (dashboard) and `mcp.example.com` (MCP). Caddy can't get certificates until these resolve.

## 3. Configure and start

On the instance:

```sh
git clone https://github.com/crbns/tandem.git && cd tandem
cat > .env <<'EOF'
WEB_DOMAIN=app.example.com
MCP_DOMAIN=mcp.example.com
ACME_EMAIL=ops@example.com
NEXT_PUBLIC_CONVEX_URL=https://<prod>.convex.cloud
NEXT_PUBLIC_MCP_URL=https://mcp.example.com
CONVEX_URL=https://<prod>.convex.cloud
EOF
docker compose -f deploy/compose.yml --env-file .env up -d --build
docker compose -f deploy/compose.yml --env-file .env ps      # web and mcp (healthy), caddy Up
```

| Variable | Used by | When |
| --- | --- | --- |
| `WEB_DOMAIN`, `MCP_DOMAIN` | Caddy | runtime |
| `ACME_EMAIL` | Caddy (Let's Encrypt account and expiry notices) | runtime |
| `NEXT_PUBLIC_CONVEX_URL` | web | **build time** (inlined into the bundle) |
| `NEXT_PUBLIC_MCP_URL` | web, Assistants page setup command | **build time** |
| `NEXT_PUBLIC_DEFAULT_WORKSPACE_ID` | web | build time, optional |
| `CONVEX_URL` | MCP server | runtime |
| `TANDEM_ALLOWED_ORIGINS` | MCP server: browser origins allowed to call `/mcp` | runtime, optional |

Changing a build-time value needs `up -d --build`; changing a runtime value needs only `up -d`. Every compose command needs the required variables, so always pass `--env-file .env`.

## 4. Smoke test

1. `https://app.example.com`: choose "Create an account", then create a workspace.
2. **Assistants → Connect an assistant:** copy the `tdm_…` token. It's shown once.
3. Connect Claude Code:
   ```sh
   claude mcp add --transport http tandem https://mcp.example.com/mcp --header "Authorization: Bearer tdm_..."
   ```
4. Ask Claude to create `proposal.md` in Tandem. Edit it in the dashboard (v2). Ask Claude to reread it: it gets v2. A stale update returns `VERSION_CONFLICT`.
5. `https://mcp.example.com/healthz` returns `{"ok":true}`, and `/mcp` without a token returns 401.

claude.ai web connectors need OAuth, which isn't implemented yet. Use Claude Code, or Claude Desktop through `mcp-remote` with the same header.

## Updating

```sh
git pull
(cd packages/backend && CONVEX_DEPLOY_KEY='<prod deploy key>' npx convex deploy)   # if convex/ changed
docker compose -f deploy/compose.yml --env-file .env up -d --build
```

Deploy Convex first when a change touches both, so the new app code never calls functions that don't exist yet. That ordering covers additions. To remove or rename a function, or to add a required argument or field, do it in two steps: first ship the new version alongside the old one and deploy the apps, then remove the old one in a later deploy.

## Operations

- **Logs:** `docker compose -f deploy/compose.yml --env-file .env logs -f web mcp caddy`.
- **Certificates:** live in the `caddy_data` volume. Don't delete it, because re-issuing certificates is rate-limited by Let's Encrypt.
- **Health:** web exposes `/api/health` and MCP exposes `/healthz`. Neither touches Convex. Caddy starts once both report healthy. Docker restarts a container when its process exits (`restart: unless-stopped`), not when it reports unhealthy, so check `ps` and the logs if one stays unhealthy.
- **Backend logs and data:** the Convex dashboard for the production deployment.
