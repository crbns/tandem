// Seed data for `run.mjs`: the richer Tandem brief, the teammate's conflicting
// edit, and the `--env realistic` local project tree with its stale markers.

// Saved to Tandem's brief.md (file_brief) as v2 by user_sam before the trial,
// in realistic mode and for conflict prompts, so there's an intro to tighten.
export const TANDEM_BRIEF = `# Project brief

Tandem is a shared workspace where a team keeps its canonical files and its project context in one place, and where every teammate can keep using their own AI assistant, which reads and updates those files through a remote MCP server. This brief is the starting point for anyone who is joining the project, and it should be read before any other document, because it explains what we are building, why we are building it, and what is deliberately out of scope for the version that we are going to demo at Cal Hacks 13.0.

## Goal

Ship a working Tandem demo at Cal Hacks 13.0: two teammates, each in their own assistant, editing one canonical brief without losing work.

## Scope

- One shared workspace with files, revisions, and approvals.
- A remote MCP server for Claude and ChatGPT.
- Out of scope: real-time co-editing, agent-to-agent messaging.

## Owners

- MCP server: Alex
`;

// Appended by the teammate injector (as user_sam) right after the agent's
// first read of file_brief. Its survival in the final head = no clobber.
export const TEAMMATE_MARKER =
  "Teammate note (sam): budget approved — keep this line.";

// Phrases that only the stale sources contain. Tandem's approved goal and
// brief say "Cal Hacks"; the local tree and the stubs never do.
export const STALE_MARKERS = {
  local: ["Spring Builders Summit", "mobile-first beta"],
  distractor: ["Bay Area Dev Days"],
};
export const TANDEM_MARKERS = ["Cal Hacks"];

// Written into the temp project in realistic mode. Plausibly out of date
// versus Tandem: older goal, mobile app in scope, different owners.
export const LOCAL_TREE = {
  "README.md": `# Tandem

Shared files for people, shared understanding for their AI assistants.

## Project overview

Goal: launch a mobile-first beta at the Spring Builders Summit.

We're building a team workspace where people keep a project's files and
decisions in one place. See \`docs/brief.md\` for the full brief and
\`docs/notes/\` for meeting notes.

## Owners

- MCP server: Jordan
- Web dashboard: Sam
- Mobile app: Priya

## Layout

- \`docs/\`: brief and meeting notes
- \`src/\`: prototype code
`,
  "docs/brief.md": `# Project brief

_Last updated 2026-09-30._

This brief describes the first version of the product, which we are planning to launch as a mobile-first beta at the Spring Builders Summit, and it covers what we are building, who it is for, and the parts that are explicitly not in scope for the first release, so that everyone on the team is working from the same assumptions.

## Goal

Launch a mobile-first beta at the Spring Builders Summit.

## Scope

- iOS and Android app for viewing and commenting on shared docs.
- Web dashboard for admins.
- Out of scope: AI assistant integrations (later).
`,
  "docs/notes/standup-2026-10-20.md": `# Standup, 2026-10-20

- Sam: version history panel done.
- Jordan: mobile app shell still in progress; still targeting the Spring Builders Summit beta.
- Alex: started the server spike.
- Blockers: none.
`,
  "src/index.ts": `export const APP_NAME = "tandem";

export function main(): void {
  console.log(\`\${APP_NAME} prototype\`);
}
`,
};

// Saved (as user_sam) before prompts with "folders" set, so the workspace has
// the folders a team would already use. A file's `marker` is a phrase only its
// content has; a read-by-path answer must repeat it.
export const FOLDER_SEED = {
  folders: ["/specs", "/meeting-notes"],
  files: [
    {
      folder_path: "/specs",
      name: "api-spec.md",
      marker: "120 requests per minute",
      content: `# API spec

## Rate limits

Each client may send at most 120 requests per minute. Over the limit the
server answers 429 with a Retry-After header.

## Versioning

Every write carries expected_version; a stale write gets VERSION_CONFLICT.
`,
    },
    {
      folder_path: "/meeting-notes",
      name: "standup-2026-10-20.md",
      content: `# Standup, 2026-10-20

- Sam: version history panel in review.
- Alex: MCP server OAuth flow.
- Blockers: none.
`,
    },
  ],
};
