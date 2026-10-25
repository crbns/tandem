# Hackathon log

- **Project:** Tandem
- **Event:** Cal Hacks 13.0
- **What it does:** A team workspace of versioned files and project context that each member's own AI assistant reads and writes through a remote MCP server.
- **Live app:** https://tandem-pink.vercel.app
- **Repo:** https://github.com/crbns/tandem
- **Frontend:** Vercel
- **Convex deployment:** https://colorful-grouse-361.convex.cloud
- **Components:** @convex-dev/mcp
- **Convex features:** schema, indexes, queries, mutations, actions, HTTP actions, crons, scheduled functions, file storage, full text search, realtime queries (`watchQuery`), paginated queries
- **Auth:** Convex Auth
- **AI models:** claude-haiku-5-5
- **Started:** 2026-10-24T01:14:02Z
- **Last updated:** 2026-10-25T16:44:41Z

## How we use Convex

Paths: `convex/` = `packages/backend/convex/`.

- **Versioned files with conflict detection:** mutations commit revision N+1 only when `expectedVersion` matches, else `VERSION_CONFLICT` (`convex/files.ts`, `convex/lib/ops.ts`).
- **Remote MCP server + OAuth for claude.ai connectors:** the `@convex-dev/mcp` component runs in HTTP actions and calls the same internal functions as the dashboard (`convex/convex.config.ts`, `convex/mcp.ts`, `convex/mcpTools.ts`).
- **Live dashboard:** the file list, Overview, Live (agent network, activity timeline) and Context screens update without a refresh via `ConvexReactClient.watchQuery` (`apps/web/lib/api/convex.ts`).
- **Context manager:** scheduled functions queue an action that calls claude-haiku-5-5 to record observations from saved files (`convex/intel.ts`, `convex/lib/intelQueue.ts`).
- **Uploads and previews:** Convex file storage, served through authorized HTTP actions (`convex/files.ts`, `convex/http.ts`).
- **File search, paging and retention:** `search_name` search index (`convex/schema.ts`), paginated `listFiles` (`convex/files.ts`), daily cron prunes old activity (`convex/crons.ts`).

## Log

All times UTC.

- 10-24 01:14 `db57cf8` Turborepo scaffold.
- 10-24 01:47 `be07f00` Pivot stack to Convex: `packages/backend`, `ConvexClientProvider.tsx`.
- 10-24 02:55 `fc7508e` MCP tools + agent skill scaffold: `apps/mcp/src/tools.ts`.
- 10-24 04:51 `fff7335` Dashboard, version-aware editor, conflict UI: `FileEditor.tsx`.
- 10-24 07:07 `593f896` Convex backend: `convex/workspaces.ts`, `files.ts`, `context.ts`.
- 10-24 07:16 `507ad95` Dashboard on Convex: `apps/web/lib/api/convex.ts`.
- 10-24 07:47 `bb80af5` Invite tokens, paginated `listFiles`: `convex/workspaces.ts`.
- 10-24 09:24 `3cadda7` MCP wired to Convex + e2e test: `convex/lib/ops.ts`, `convex/mcp.ts`.
- 10-24 12:02 `c675217` Demo seed and reset: `convex/seed.ts`.
- 10-24 12:24 `6f962d0` MCP + OAuth on `@convex-dev/mcp`: `convex/mcpTools.ts`.
- 10-24 12:47 `dc2f17f` Project context page: `ContextFieldPanel.tsx`, `convex/context.ts`.
- 10-24 14:17 `c66ac76` Binary uploads, PDF/image preview: `convex/files.ts`, `convex/http.ts`.
- 10-24 17:54 `161a19c` Tasks via `manage_task`: `convex/lib/ops.ts`.
- 10-24 18:10 `d9811eb` Nested folders: `convex/lib/fs.ts`, `convex/mcpTools.ts`.
- 10-24 19:52 `e29a5a2` Sync-before/log-after MCP loop: `convex/lib/mcpLoop.ts`.
- 10-24 22:02 `9931d08` Toast for assistant-saved files: `lib/api/useWorkspace.ts`.
- 10-25 00:55 `aab425d` Live activity view: `convex/activity.ts`, `AgentNetwork.tsx`.
- 10-25 00:55 `e94ca61` Conflict detection/resolution: `convex/conflicts.ts`.
- 10-25 03:19 `1c4daa5` Invite short code + QR: `convex/workspaces.ts`, `InviteDialog.tsx`.
- 10-25 04:23 `794eec7` Haiku context manager: `convex/intel.ts`, `convex/lib/intel.ts`.
- 10-25 08:06 `c2d8920` Context changes apply at once: `convex/context.ts`.
- 10-25 09:47 `77b9fa9` Context manager writes goals/decisions/owners: `convex/intel.ts`.
- 10-25 16:44 `d2ec32e` README: live URL, Convex summary: `README.md`.
