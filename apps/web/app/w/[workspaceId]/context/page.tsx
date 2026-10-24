"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { useParams } from "next/navigation";
import { useTandemApi } from "@/lib/api";
import { useResource } from "@/lib/api/useResource";
import { useWorkspaceRefresh, useWorkspaceRole } from "@/lib/api/useWorkspace";
import { contextSections, loadContextPage } from "@/lib/context";
import { canDecideProposals } from "@/lib/proposals";
import { orderTasks, TASK_STATUS_LABEL } from "@/lib/tasks";
import { formatAbsolute } from "@/lib/time";
import type { Task } from "@/lib/api/types";
import type { Resource } from "@/lib/api/useResource";
import {
  ContextFieldPanel,
  SourceLinks,
} from "@/components/context/ContextFieldPanel";
import { ActorBadge } from "@/components/common/ActorBadge";
import { ErrorState } from "@/components/common/ErrorState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export default function ContextPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  // Route key isolates drafts and pagination when navigating between workspaces.
  return <WorkspaceContext key={workspaceId} workspaceId={workspaceId} />;
}

function WorkspaceContext({ workspaceId }: { workspaceId: string }) {
  const api = useTandemApi();
  const role = useWorkspaceRole(workspaceId);
  const [pageCount, setPageCount] = useState(1);
  const load = useCallback(
    () => loadContextPage(api, workspaceId, pageCount),
    [api, workspaceId, pageCount],
  );
  const { resource, refreshing, reload } = useResource(load);
  useWorkspaceRefresh(workspaceId, reload);
  const loadTasks = useCallback(() => api.listTasks(workspaceId), [api, workspaceId]);
  const tasks = useResource(loadTasks);
  // Every task write records a workspace event, so this fires on task changes too.
  useWorkspaceRefresh(workspaceId, tasks.reload);
  const canEdit = canDecideProposals(role);
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold leading-8 tracking-[-0.01em]">
          Project context
        </h1>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            reload();
            tasks.reload();
          }}
          disabled={refreshing || tasks.refreshing}
        >
          Refresh
        </Button>
      </div>
      <p className="-mt-2 text-sm text-muted-foreground">
        The team&apos;s current shared understanding. Owners and admins save
        decisions directly; constraints and open questions are recorded immediately.
        Members propose major changes for{" "}
        <Link
          href={`/w/${workspaceId}/approvals`}
          className="underline underline-offset-2"
        >
          approval
        </Link>
        .
      </p>
      {resource.status === "loading" && (
        <Skeleton className="h-64" aria-label="Loading project context" />
      )}
      {resource.status === "error" && (
        <ErrorState
          error={resource.error}
          onRetry={reload}
          retrying={refreshing}
        />
      )}
      {resource.status === "ready" && (
        <>
          <p className="label-caps text-muted-foreground">
            Version {resource.data.context.version}
          </p>
          <div className="flex flex-col gap-3">
            {contextSections(resource.data.context).map((section) => (
              <ContextFieldPanel
                key={section.field}
                {...section}
                workspaceId={workspaceId}
                version={resource.data.context.version}
                canEdit={canEdit}
                canPropose={role === "member"}
                files={resource.data.files}
                members={resource.data.members}
                onSaved={reload}
              />
            ))}
          </div>
          <section
            aria-labelledby="published-work"
            className="mt-3 flex flex-col gap-3"
          >
            <h2 id="published-work" className="text-lg font-bold">
              Published work
            </h2>
            <p className="text-sm text-muted-foreground">
              Findings and deliverables shared with the workspace.
            </p>
            {resource.data.work.length === 0 ? (
              <p className="rounded-md border border-dashed bg-card px-5 py-6 text-sm text-muted-foreground">
                No published work yet.
              </p>
            ) : (
              <ul className="divide-y rounded-md border bg-card">
                {resource.data.work.map((work) => (
                  <li key={work.id} className="flex flex-col gap-2 px-5 py-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3 className="break-words font-semibold">
                        {work.title}
                      </h3>
                      <span className="label-caps text-muted-foreground">
                        {work.kind}
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap break-words text-sm">
                      {work.summary}
                    </p>
                    <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <ActorBadge actor={work.createdBy} />
                      <span>Published {formatAbsolute(work.createdAt)}</span>
                    </p>
                    <SourceLinks
                      workspaceId={workspaceId}
                      ids={work.fileIds}
                      files={resource.data.files}
                    />
                  </li>
                ))}
              </ul>
            )}
            {resource.data.hasMore && (
              <Button
                variant="outline"
                disabled={refreshing || resource.data.loadedPages !== pageCount}
                onClick={() => setPageCount((count) => count + 1)}
              >
                Load more work
              </Button>
            )}
          </section>
        </>
      )}
      <TasksSection
        resource={tasks.resource}
        onRetry={tasks.reload}
        retrying={tasks.refreshing}
      />
    </div>
  );
}

const STATUS_BADGE = {
  open: "outline",
  in_progress: "secondary",
  done: "outline",
} as const;

/** Read-only: assistants create, claim and complete tasks through MCP. */
function TasksSection({
  resource,
  onRetry,
  retrying,
}: {
  resource: Resource<Task[]>;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <section aria-labelledby="tasks" className="mt-3 flex flex-col gap-3">
      <h2 id="tasks" className="text-lg font-bold">
        Tasks
      </h2>
      <p className="text-sm text-muted-foreground">
        Work the team&apos;s assistants have split up and claimed. Active tasks
        come first.
      </p>
      {resource.status === "loading" && (
        <Skeleton className="h-24" aria-label="Loading tasks" />
      )}
      {resource.status === "error" && (
        <ErrorState error={resource.error} onRetry={onRetry} retrying={retrying} />
      )}
      {resource.status === "ready" &&
        (resource.data.length === 0 ? (
          <p className="rounded-md border border-dashed bg-card px-5 py-6 text-sm text-muted-foreground">
            No tasks yet. Assistants can create and claim tasks with the
            manage_task tool.
          </p>
        ) : (
          <ul className="divide-y rounded-md border bg-card">
            {orderTasks(resource.data).map((task) => (
              <li key={task.id} className="flex flex-col gap-2 px-5 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3
                    className={
                      task.status === "done"
                        ? "break-words font-semibold text-muted-foreground"
                        : "break-words font-semibold"
                    }
                  >
                    {task.title}
                  </h3>
                  <Badge variant={STATUS_BADGE[task.status]}>
                    {TASK_STATUS_LABEL[task.status]}
                  </Badge>
                </div>
                {task.description && (
                  <p className="whitespace-pre-wrap break-words text-sm">
                    {task.description}
                  </p>
                )}
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>
                    {task.ownerName ? (
                      <>
                        Owner{" "}
                        <span className="font-medium text-foreground">
                          {task.ownerName}
                        </span>
                      </>
                    ) : (
                      "Unclaimed"
                    )}
                  </span>
                  <ActorBadge actor={task.updatedBy} />
                  <span>
                    {task.status === "done" && task.completedAt !== null
                      ? `Completed ${formatAbsolute(task.completedAt)}`
                      : `Updated ${formatAbsolute(task.updatedAt)}`}
                  </span>
                </p>
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}
