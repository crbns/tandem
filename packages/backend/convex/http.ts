import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { mcp } from "./mcp";

const http = httpRouter();
auth.addHttpRoutes(http);
// /mcp, /mcp/oauth/* and the OAuth discovery documents under /.well-known.
mcp.registerRoutes(http);

export default http;
