import { httpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { httpAction, env } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { auth } from "./auth";
import { normalizeHookEvent, type HookEvent } from "./lib/activityLog";
import { sha256Hex } from "./lib/mcpConfig";
import { mcp } from "./mcp";

const http = httpRouter();
auth.addHttpRoutes(http);
// /mcp, /mcp/oauth/* and the OAuth discovery documents under /.well-known.
mcp.registerRoutes(http);

function contentHeaders(request: Request) {
  const headers = new Headers({ "Cache-Control": "private, no-store" });
  const origin = request.headers.get("Origin");
  if (env.SITE_URL && origin === new URL(env.SITE_URL).origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
    headers.set("Access-Control-Allow-Headers", "Authorization");
    headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  }
  return headers;
}

http.route({
  pathPrefix: "/files/",
  method: "OPTIONS",
  handler: httpAction(
    async (_ctx, request) =>
      new Response(null, { status: 204, headers: contentHeaders(request) }),
  ),
});

http.route({
  pathPrefix: "/files/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const headers = contentHeaders(request);
    if (!(await ctx.auth.getUserIdentity()))
      return new Response("Unauthenticated", { status: 401, headers });
    const url = new URL(request.url);
    const match = /^\/files\/([^/]+)\/content$/.exec(url.pathname);
    if (!match) return new Response("Not found", { status: 404, headers });
    const version = url.searchParams.get("version");
    if (
      version !== null &&
      (!/^\d+$/.test(version) ||
        !Number.isSafeInteger(Number(version)) ||
        Number(version) < 1)
    )
      return new Response("Invalid version", { status: 400, headers });
    try {
      const file = await ctx.runQuery(internal.files.getBinaryContent, {
        fileId: match[1]!,
        ...(version === null ? {} : { version: Number(version) }),
      });
      const blob = await ctx.storage.get(file.storageId);
      if (!blob) return new Response("Not found", { status: 404, headers });
      headers.set("Content-Type", file.mimeType);
      const preview =
        file.mimeType === "application/pdf" ||
        /^image\/(png|jpeg|gif|webp|avif)$/.test(file.mimeType);
      headers.set(
        "Content-Disposition",
        `${preview ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      );
      return new Response(blob, { headers });
    } catch (error) {
      // ConvexError data can cross a query boundary as serialized JSON.
      let code: unknown;
      if (error instanceof ConvexError) {
        const data =
          typeof error.data === "string" ? JSON.parse(error.data) : error.data;
        if (data && typeof data === "object" && "code" in data)
          code = data.code;
      }
      const status =
        code === "UNAUTHENTICATED"
          ? 401
          : code === "FORBIDDEN"
            ? 403
            : code === "FILE_NOT_FOUND"
              ? 404
              : code === "INVALID_INPUT"
                ? 400
                : 500;
      return new Response(
        status === 403
          ? "Forbidden"
          : status === 404
            ? "Not found"
            : status === 401
              ? "Unauthenticated"
              : "Unable to load file",
        { status, headers },
      );
    }
  }),
});

const HOOK_BODY_MAX = 64 * 1024;
const HOOK_BATCH_MAX = 25;

function json(status: number, body: object) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Claude Code hook events (docs/context-intelligence.md), authenticated with
 * the connection's own MCP API key. The key alone decides the connection and
 * so the workspace; nothing in the body can. One event, or `{ events: [...] }`
 * (at most 25) for batching and replay, stored in one mutation.
 */
http.route({
  path: "/activity/claude-code",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const bearer = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("Authorization") ?? "");
    if (!bearer) return json(401, { error: "UNAUTHENTICATED" });
    const info = await ctx.runQuery(components.mcp.tokens.verify, {
      hash: await sha256Hex(bearer[1]!),
      now: Date.now(),
    });
    if (!info) return json(401, { error: "UNAUTHENTICATED" });
    if (!info.scopes.includes("tandem:write")) return json(403, { error: "FORBIDDEN", scope: "tandem:write" });
    if (Number(request.headers.get("Content-Length") ?? 0) > HOOK_BODY_MAX)
      return json(413, { error: "PAYLOAD_TOO_LARGE" });
    const text = await request.text();
    if (text.length > HOOK_BODY_MAX) return json(413, { error: "PAYLOAD_TOO_LARGE" });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json(400, { error: "INVALID_INPUT", message: "Body must be JSON." });
    }
    const batch =
      body !== null && typeof body === "object" && "events" in body ? (body as { events: unknown }).events : undefined;
    if (batch !== undefined && (!Array.isArray(batch) || batch.length < 1 || batch.length > HOOK_BATCH_MAX))
      return json(400, { error: "INVALID_INPUT", message: `events must be an array of 1–${HOOK_BATCH_MAX} events.` });
    const events: HookEvent[] = [];
    for (const raw of batch ?? [body]) {
      const normalized = normalizeHookEvent(raw);
      if ("error" in normalized) return json(400, { error: "INVALID_INPUT", message: normalized.error });
      events.push(normalized.event);
    }
    const results = await ctx.runMutation(internal.activityLog.ingestHookEvent, {
      connectionId: info.userId,
      events,
    });
    if (!results) return json(403, { error: "FORBIDDEN" });
    return batch === undefined
      ? json(202, { ok: true, ...results[0] })
      : json(202, { ok: true, results });
  }),
});

export default http;
