import type { Task, TaskStatus } from "@/lib/api/types";

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  done: "Done",
};

/** Active tasks (open, in progress) before done ones, each newest update first. */
export function orderTasks(tasks: readonly Task[]): Task[] {
  return [...tasks].sort(
    (a, b) =>
      Number(a.status === "done") - Number(b.status === "done") ||
      b.updatedAt - a.updatedAt,
  );
}
