#!/usr/bin/env node
// Tiny distractor MCP servers for `run.mjs --env realistic`: a "notes" app and
// a "tracker" with canned, plausibly stale data, so the model has non-Tandem
// sources to choose from. Stateless streamable HTTP with JSON responses (POST
// only, no sessions, no SSE). No npm dependencies.
//
//   node skills/tandem/eval/stub-mcp.mjs <notes|tracker> <port>

import { createServer } from "node:http";

const NOTES = [
  {
    id: "note_kickoff",
    title: "Kickoff notes (2026-09-28)",
    updated: "2026-09-28",
    body:
      "Kickoff. Goal: demo a mobile beta at Bay Area Dev Days. " +
      "Mobile app is in scope for v1. Owners: Jordan on the MCP server, Sam on the web dashboard. " +
      "Open question: do we need offline mode?",
  },
  {
    id: "note_design",
    title: "Design review: file history",
    updated: "2026-10-12",
    body:
      "Every edit creates a new revision; restoring makes a new head revision. " +
      "We still need to decide how conflict errors are shown in the dashboard.",
  },
  {
    id: "note_personal",
    title: "Groceries",
    updated: "2026-10-19",
    body: "Oat milk, coffee beans, rice, limes.",
  },
];

const TICKETS = [
  {
    id: "TAN-4",
    title: "Version history panel",
    status: "done",
    assignee: "Sam",
    description: "Show revisions for a file, newest first.",
  },
  {
    id: "TAN-7",
    title: "Mobile app shell (v1)",
    status: "in progress",
    assignee: "Jordan",
    description: "React Native shell for the Bay Area Dev Days beta.",
  },
  {
    id: "TAN-9",
    title: "Remote MCP server: update_document",
    status: "in review",
    assignee: "Alex",
    description: "Optimistic versioning with expected_version.",
  },
  {
    id: "TAN-11",
    title: "Weekly status template",
    status: "todo",
    assignee: null,
    description: "A short template for the weekly project update.",
  },
];

const str = (description) => ({ type: "string", description });

const SERVERS = {
  notes: {
    tools: [
      {
        name: "notes_search",
        description:
          "Search your personal notes by keyword. Returns matching note ids, titles, and snippets.",
        inputSchema: {
          type: "object",
          properties: { query: str("Keywords to search for.") },
          required: ["query"],
        },
        call: ({ query }) => {
          const words = String(query ?? "")
            .toLowerCase()
            .split(/\W+/)
            .filter(Boolean);
          const hits = NOTES.filter((n) =>
            words.some((w) => `${n.title} ${n.body}`.toLowerCase().includes(w)),
          );
          return {
            results: (hits.length ? hits : NOTES).map((n) => ({
              id: n.id,
              title: n.title,
              updated: n.updated,
              snippet: n.body.slice(0, 120),
            })),
          };
        },
      },
      {
        name: "notes_read",
        description: "Read one note by id.",
        inputSchema: {
          type: "object",
          properties: { id: str("Note id from notes_search.") },
          required: ["id"],
        },
        call: ({ id }) => {
          const note = NOTES.find((n) => n.id === id);
          if (!note) throw new Error(`No note ${id}`);
          return note;
        },
      },
    ],
  },
  tracker: {
    tools: [
      {
        name: "list_tickets",
        description:
          "List issue-tracker tickets, optionally filtered by status (todo, in progress, in review, done).",
        inputSchema: {
          type: "object",
          properties: { status: str("Optional status filter.") },
        },
        call: ({ status } = {}) => ({
          tickets: TICKETS.filter((t) => !status || t.status === status).map(
            ({ id, title, status: s, assignee }) => ({
              id,
              title,
              status: s,
              assignee,
            }),
          ),
        }),
      },
      {
        name: "get_ticket",
        description: "Get one ticket by id, e.g. TAN-7.",
        inputSchema: {
          type: "object",
          properties: { id: str("Ticket id.") },
          required: ["id"],
        },
        call: ({ id }) => {
          const t = TICKETS.find((x) => x.id === id);
          if (!t) throw new Error(`No ticket ${id}`);
          return t;
        },
      },
    ],
  },
};

const [kind, portArg] = process.argv.slice(2);
const spec = SERVERS[kind];
const port = Number(portArg);
if (!spec || !Number.isInteger(port)) {
  console.error("Usage: stub-mcp.mjs <notes|tracker> <port>");
  process.exit(2);
}

function handle(msg) {
  if (!msg || typeof msg !== "object" || msg.id === undefined) return null; // notification
  const ok = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message) => ({
    jsonrpc: "2.0",
    id: msg.id,
    error: { code, message },
  });
  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: kind, version: "0.0.1" },
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({
        tools: spec.tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
          annotations: { readOnlyHint: true, openWorldHint: false },
        })),
      });
    case "tools/call": {
      const tool = spec.tools.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(-32602, `Unknown tool ${msg.params?.name}`);
      try {
        const out = tool.call(msg.params?.arguments ?? {});
        return ok({
          content: [{ type: "text", text: JSON.stringify(out) }],
          structuredContent: out,
        });
      } catch (err) {
        return ok({
          isError: true,
          content: [{ type: "text", text: err.message }],
        });
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

createServer((req, res) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  if (pathname === "/healthz" && req.method === "GET")
    return send(res, 200, { ok: true });
  if (pathname !== "/mcp") return send(res, 404, { error: "not_found" });
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed; use POST." },
      id: null,
    });
  }
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
        id: null,
      });
    }
    const replies = (Array.isArray(msg) ? msg : [msg])
      .map(handle)
      .filter(Boolean);
    if (!replies.length) {
      res.writeHead(202);
      return res.end();
    }
    send(res, 200, Array.isArray(msg) ? replies : replies[0]);
  });
}).listen(port, "127.0.0.1");
