import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireMembership } from "./lib/auth";
import { listTasks as listWorkspaceTasks, toTask } from "./lib/ops";
import { taskValidator } from "./lib/validators";

const DASHBOARD_TASK_LIMIT = 100;

/** The dashboard's task list: every status, newest updatedAt first. */
export const listTasks = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(taskValidator),
  handler: async (ctx, args) => {
    await requireMembership(ctx, args.workspaceId);
    const tasks = await listWorkspaceTasks(
      ctx,
      args.workspaceId,
      undefined,
      DASHBOARD_TASK_LIMIT,
    );
    return await Promise.all(tasks.map((task) => toTask(ctx, task)));
  },
});
