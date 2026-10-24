# Product

<!-- impeccable:product-schema 1 -->

Scope: the Tandem web dashboard (`apps/web`). The MCP server, Skill, and docs app are separate surfaces and would get their own records.

## Platform

web

## Users

Small teams in any field (software development is one example, not the target) where every member keeps working with their own AI assistant in its native app: Claude, ChatGPT, or Gemini. In the dashboard, a team member signs in to:

- find files that teammates or assistants created;
- read and edit the canonical copy of a file;
- save a new version without overwriting anyone else's work;
- see who changed what, and whether it was a person or an assistant.

## Product Purpose

Tandem gives a team one shared, versioned set of files, plus compact project context (goal, scope, constraints, approved decisions, ownership, open questions). Humans and their AI assistants both work from it. People use the dashboard; assistants connect through a remote MCP server and a companion Agent Skill.

It exists because each person's assistant otherwise works from a private, drifting copy of the project. Success means a teammate can open the dashboard and do three things:

- find a file an assistant created;
- edit and save it as a new version;
- trust that a stale write, human or agent, is rejected rather than silently overwriting newer work.

## Positioning

Tandem is not a chat app and not an agent platform. People keep their own assistants in the assistants' own apps. Tandem owns the shared ground truth:

- canonical files with full revision history;
- approved project context that references those files instead of copying them;
- an attribution trail that separates human edits from agent edits.

Assistants never message each other. They meet only through the files and the context.

## Operating Context

- **How assistants connect:** through Tandem's remote MCP server (Streamable HTTP + OAuth), guided by the Agent Skill. Claude remote connectors are the primary client. ChatGPT write access and Gemini custom apps have plan/eligibility limits (as of Oct 2026).
- **How people work:** in the web dashboard. Binary uploads go through the dashboard first, because native chats can't be assumed to send binaries over MCP.
- **Freshness:** native chats can't be woken by Tandem events. The dashboard refreshes on demand and when the window regains focus, so an assistant's new file appears after a refresh; there is no realtime in P0.
- **Current setting:** built for Cal Hacks 13.0 (Oct 23–25, 2026). The P0 demo shows Claude creating `proposal.md` at v1, a human editing and saving v2, Claude rereading v2, a stale write rejected, and history attributing every version.

## Capabilities and Constraints

**Versioning**
- Every write carries `expectedVersion`. A stale write returns `VERSION_CONFLICT`, and the client must reread and reconcile.
- The dashboard never silently overwrites a newer version or discards a user's unsaved draft.
- A commit atomically creates version N+1, its attribution, and a workspace event.
- History is immutable. Restore (not in P0) creates a new head revision.

**Approvals and attribution**
- Changes to goal, scope, major decisions, and ownership need human approval: agents propose, a permitted human approves.
- Every record carries actor attribution, person and agent.

**Presence and privacy**
- Presence is honest. Show "last edited" or "last sync", never "online".
- Private conversation history is never exported automatically. Only authorized, relevant work is published.

**Security**
- File content is untrusted. It is never executed or rendered as raw HTML.
- Every read enforces workspace (tenant) boundaries.

**Out of scope**
- Agent-to-agent messaging, agent inboxes, and message-flow UI were cut on purpose.

**Terminology**
- workspace; file; version / revision; head; conflict; actor (human or agent); assistant; context; proposal; approval.

**Not decided yet**
- Members/invite flows, the approvals screen, the activity feed, folders, binary previews, and how project context appears in the dashboard (beyond the approved goal named as P0). These are P1+.

## Brand Commitments

- The name is **Tandem**, and it is binding.
- The tagline "Shared files for people. Shared understanding for their AI assistants." is a working draft and may change.
- There is no logo, mark, or other brand asset yet.

## Evidence on Hand

- **Demo data (mock):** in `lib/api/mock.ts`, three files: `proposal.md`, `brief.md` and `notes.txt`. Its actors are Claude, Alex and Demo Human.
- **Not available yet:** real customers, testimonials, usage data, and screenshots of real teams. Future work must not invent them.

## Product Principles

1. The shared file is the source of truth. Assistants and people both read and write the canonical copy, never a private fork.
2. Never lose work silently. Conflicts are shown, drafts are kept, and nothing retries or overwrites on its own.
3. Always say who did it. Every change is attributed to a person or an agent, plainly and honestly.
4. Humans hold the pen on direction. Agents propose changes to goals, scope, decisions, and ownership; people approve them.
5. Bring your own assistant. Tandem meets people inside the tools they already use rather than replacing them.

## Accessibility & Inclusion

No product-specific standard has been set yet. The dashboard currently aims for keyboard operability, screen-reader labels, and changes that don't rely on colour alone (see the review fixes on `feat/web-dashboard`).
