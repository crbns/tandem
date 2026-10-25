// The Haiku context manager (docs/context-intelligence.md). Foundation stub:
// the processing worker replaces this with the real batch pipeline.
import { v } from "convex/values";
import { internalAction } from "./_generated/server";

export const processWorkspace = internalAction({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async () => null,
});
