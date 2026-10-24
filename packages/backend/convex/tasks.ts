import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireMembership } from "./lib/auth";
import { listActiveTasks, listTasks as listWorkspaceTasks, toTask } from "./lib/ops";
import { taskValidator } from "./lib/validators";

const DASHBOARD_TASK_LIMIT = 100;

/**
 * The dashboard's task list: open and in-progress tasks first, then done
 * tasks fill the rest, each newest updatedAt first.
 */
export const listTasks = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(taskValidator),
  handler: async (ctx, args) => {
    await requireMembership(ctx, args.workspaceId);
    const active = await listActiveTasks(ctx, args.workspaceId, DASHBOARD_TASK_LIMIT);
    const done =
      active.length < DASHBOARD_TASK_LIMIT
        ? await listWorkspaceTasks(
            ctx,
            args.workspaceId,
            "done",
            DASHBOARD_TASK_LIMIT - active.length,
          )
        : [];
    const tasks = [...active, ...done];
    return await Promise.all(tasks.map((task) => toTask(ctx, task)));
  },
});
