import { defineApp } from "convex/server";
import { v } from "convex/values";
import mcp from "@convex-dev/mcp/convex.config.js";

// No httpPrefix: the MCP component serves OAuth discovery at the origin root.
const app = defineApp({
  env: {
    // The dashboard origin. Convex Auth also reads it for sign-in redirects.
    SITE_URL: v.optional(v.string()),
    // Overrides `${SITE_URL}/oauth/consent` as the MCP consent page.
    MCP_CONSENT_URL: v.optional(v.string()),
  },
});
app.use(mcp);
export default app;
