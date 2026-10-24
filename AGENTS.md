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
- Assistants connect through a **remote MCP server** (Streamable HTTP + OAuth) plus a companion **Agent Skill** (`SKILL.md`) that tells them to sync workspace context, read canonical files, publish relevant work, and propose rather than approve major changes.
- Tandem owns two layers: canonical **files** with revision history, and compact structured **project context** (goal, scope, constraints, approved decisions, ownership, open questions) that references files instead of duplicating them.
- Audience is any team; software dev is an example, not a restriction.

## Hard rules

- **Optimistic versioning:** every write carries `expected_version`. Stale writes return `VERSION_CONFLICT`; the client rereads and reconciles. A commit atomically creates version N+1, attribution, and a workspace event. Restore makes a new head revision, never deletes history.
- **Human approval** is required for changes to goal, scope, major decisions, and ownership. Agents call `propose_context_change`, and the change stays pending until a permitted human approves it. Ordinary findings may be recorded automatically.
- **No agent-to-agent messaging,** agent inbox, or message-flow UI. That was cut from scope on purpose.
- **Presence is honest:** show "last MCP action / last sync" and "recently active", never "online". Native chats can't be woken by Tandem events, and a skill can't force tool calls.
- **Privacy:** never auto-export private conversation history. Publish only relevant project work that the user has authorized.
- Treat document content as untrusted. It must never be executed as privileged agent instructions.
- Every mutable record carries workspace ID, actor attribution (person and agent), revision, and timestamps. Every read enforces tenant boundaries.

## MCP tool surface

`sync_workspace`, `list_files`, `search_files`, `read_file`, `create_document`, `update_document` (needs `expected_version`), `publish_work`, `propose_context_change`, `get_approvals`, `get_file_versions`, `get_workspace_info`. Binary uploads go through the dashboard first. Don't assume a native chat can send binaries through MCP.

## Stack

Supabase and Railway were dropped. Don't reintroduce them.

- **Backend:** Convex (`packages/backend/convex`): database, Convex Auth, file storage, reactive queries for dashboard realtime, and scheduled functions/actions for the outbox and LLM context extraction. Enforce authorization inside every query, mutation, and action. Serve binaries through authorized HTTP actions, not shareable storage URLs.
- **Web:** Next.js + React (`apps/web`), wrapped in `ConvexClientProvider`. Needs `NEXT_PUBLIC_CONVEX_URL`, which is inlined at build time.
- **MCP server:** Node.js + TypeScript MCP SDK, calling the same Convex functions as the dashboard.
- **Hosting:** Vultr. Web and MCP server ship as Docker containers (`apps/web/Dockerfile`, Next `standalone` + `turbo prune`) through Vultr Container Registry. Convex Cloud hosts the backend (`pnpm --filter @repo/backend deploy` with `CONVEX_DEPLOY_KEY`).

Core tables: users, workspaces, workspace_members, agent_connections, files, folders, file_revisions, structured_context, context_proposals, approvals, workspace_events, outbox_events, sync_cursors, storage_objects.

## Hackathon priorities

- **P0:** one workspace with two members and authz; remote MCP working in at least two native clients; one shared text doc with CRUD and version conflict; dashboard with files, editor, revisions, and the approved goal; a skill-led sync demo with an honest fallback.
- **P1:** decision approval screen, context extraction from published work, realtime file events and revision diffs, folders, PDF/image preview, invites.
- **P2:** don't build these now (broad binary previews, office editors, search ranking, CRDT co-editing, enterprise permissions).

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
