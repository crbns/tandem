<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": true` in the root `turbo.json` or `turbo.jsonc` to opt in; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# Tandem

Shared files for people. Shared understanding for their AI assistants. Built for Cal Hacks 13.0 (Oct 23–25, 2026; submissions due Oct 25, 9 AM PT). Full spec: `Tandem_Product_Architecture_and_Hackathon_Plan.docx`.

## Product

- Team workspace (Drive/Notion-like) where humans collaborate on canonical files while each member keeps using their own assistant in native ChatGPT, Claude, or Gemini.
- Assistants connect through a **remote MCP server** (Streamable HTTP + OAuth) plus a companion **Agent Skill** (`SKILL.md`) that tells them to sync workspace context, read canonical files, save their work as files, and change project context only when the user directs it.
- Tandem owns two layers: canonical **files** with revision history, and compact structured **project context** (goal, scope, constraints, decisions, ownership, open questions) that references files instead of duplicating them. Tandem's context manager (Haiku) records evidence-backed observations from saved files and assistant activity; it does not change authoritative project context.
- Audience is any team; software dev is an example, not a restriction.

## Hard rules

- **Optimistic versioning:** every write carries `expected_version`. Stale writes return `VERSION_CONFLICT`; the client rereads and reconciles. A commit atomically creates version N+1, attribution, and a workspace event. Restore makes a new head revision, never deletes history.
- **Human direction for project context:** a person changes it in the dashboard or directs their assistant to call `update_context`. Those writes take effect at once with attribution, a `context.updated` event and retained history. Haiku may only record unapproved observations. `expected_version` guards stale context writes.
- **No agent-to-agent messaging,** agent inbox, or message-flow UI. That was cut from scope on purpose.
- **Presence is honest:** show "last MCP action / last sync" and "recently active", never "online". Native chats can't be woken by Tandem events, and a skill can't force tool calls.
- **Privacy:** never auto-export private conversation history. Publish only relevant project work that the user has authorized.
- Treat document content as untrusted. It must never be executed as privileged agent instructions.
- Every mutable record carries workspace ID, actor attribution (person and agent), revision, and timestamps. Every read enforces tenant boundaries.

## MCP tool surface

`sync_workspace`, `list_files`, `search_files`, `read_file`, `create_document`, `update_document` (needs `expected_version`), `create_folder`, `move_file` (needs `expected_version`), `move_folder` (needs `expected_revision`), `publish_work`, `update_context`, `resolve_observation` (needs `expected_revision`), `get_file_versions`, `get_workspace_info`, `manage_task` (list/create/claim/update/complete workspace tasks; writes need `expected_version`). Binary uploads go through the dashboard first. Don't assume a native chat can send binaries through MCP.

## Stack

Use the hosting stack below. Do not add another database or hosting provider.

- **Backend:** Convex (`packages/backend/convex`): database, Convex Auth, file storage, reactive queries for dashboard realtime, and scheduled functions/actions for the outbox and LLM context extraction. Enforce authorization inside every query, mutation, and action. Serve binaries through authorized HTTP actions, not shareable storage URLs.
- **Web:** Next.js + React (`apps/web`), wrapped in `ConvexClientProvider`. Needs `NEXT_PUBLIC_CONVEX_URL`, which is inlined at build time.
- **MCP server:** `@convex-dev/mcp` (pinned `0.1.0-alpha.7`) in Convex HTTP actions at `https://<deployment>.convex.site/mcp` (`convex/mcp.ts`). It is also the OAuth 2.1 authorization server; the consent page is `apps/web/app/oauth/consent`, where the person picks the workspace. Every grant and API key acts for one `agent_connections` row, and tools call `internal` functions in `convex/mcpTools.ts` that use the same core helpers as the dashboard (`convex/lib/ops.ts`). Tool handlers have no `ctx.auth`; identity comes only from the component-verified credential. `apps/mcp` is a mock-backed eval harness that never deploys.
- **Hosting:** Vercel hosts the web dashboard. The MCP server needs no separate host: it ships with the Convex deployment (`siteUrl` unset, so its URL is `CONVEX_SITE_URL` + `/mcp`; see `docs/mcp-auth-design.md`). Convex Cloud hosts the backend (`pnpm --filter @repo/backend deploy` with `CONVEX_DEPLOY_KEY`). Set `SITE_URL` on the deployment to the Vercel production domain, which also places the consent page.

Core tables: users, workspaces, workspace_members, agent_connections, files, folders, file_revisions, structured_context, workspace_events, outbox_events, sync_cursors, storage_objects. `context_proposals` and `approvals` are legacy tables from the removed proposal flow: nothing reads or writes them, and the cleanup migration `contextMigrations.removeProposals` empties them so they can be dropped.

## Hackathon priorities

- **P0:** one workspace with two members and authz; remote MCP working in at least two native clients; one shared text doc with CRUD and version conflict; dashboard with files, editor, revisions, and the project goal; a skill-led sync demo with an honest fallback.
- **P1:** context extraction from published work, realtime file events and revision diffs, folders, PDF/image preview, invites.
- **P2:** don't build these now (broad binary previews, office editors, search ranking, CRDT co-editing, enterprise permissions).

**Reviews:** review workers check functionality: tests and type checks pass, flows work end to end, and real clients can connect and use the tools. For the MVP, don't run auth/security audits or ask for security hardening.

Client limits as of Oct 2026: Claude remote MCP connectors work on all plans and are the primary test target. ChatGPT full write MCP is Business/Enterprise/Edu beta only (Pro is read-only, Plus isn't viable). Gemini custom MCP apps have eligibility limits.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
