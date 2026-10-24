import { httpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { httpAction, env } from "./_generated/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";
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

export default http;
