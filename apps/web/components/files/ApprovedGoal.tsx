"use client";

import { useCallback } from "react";
import { ChevronRightIcon } from "lucide-react";
import { useTandemApi } from "@/lib/api";
import { useResource } from "@/lib/api/useResource";
import { formatAbsolute, formatRelative } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { ActorBadge } from "@/components/common/ActorBadge";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The approved project context, read-only. Changes are proposed by people or
 * assistants and only appear here once a teammate approves them.
 */
export function ApprovedGoal({ workspaceId }: { workspaceId: string }) {
  const api = useTandemApi();
  const now = useNow();
  const load = useCallback(() => api.getContext(workspaceId), [api, workspaceId]);
  const { resource, reload } = useResource(load);

  if (resource.status === "loading") {
    return <Skeleton className="h-[5.5rem] w-full" aria-label="Loading the approved goal" />;
  }

  if (resource.status === "error") {
    return (
      <p className="rounded-md border bg-card px-5 py-4 text-sm text-muted-foreground">
        Couldn&apos;t load the approved goal.{" "}
        <button type="button" onClick={reload} className="font-medium text-foreground underline">
          Try again
        </button>
      </p>
    );
  }

  const ctx = resource.data;
  if (!ctx) {
    return (
      <section aria-labelledby="goal-heading" className="rounded-md border border-dashed bg-card px-5 py-4">
        <h2 id="goal-heading" className="text-sm font-semibold">
          No approved goal yet
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Teammates or their assistants can propose one; it appears here once a teammate approves it.
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="goal-heading" className="rounded-md border bg-card px-5 py-4">
      {/* The goal itself is the heading; its status reads as the line beneath. */}
      <h2 id="goal-heading" className="text-base font-semibold leading-6">
        {ctx.goal}
      </h2>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Approved goal</span>
        <span className="label-caps rounded-sm bg-archive-tint px-1.5 py-0.5 text-archive">v{ctx.version}</span>
        <span>approved by</span>
        <ActorBadge actor={ctx.approvedBy} />
        <span title={formatAbsolute(ctx.approvedAt)}>{formatRelative(ctx.approvedAt, now)}</span>
      </p>
      <details className="group mt-3 text-sm">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
          <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
          Scope, constraints and decisions
        </summary>
        <dl className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
          <dt className="label-caps pt-0.5 text-muted-foreground">Scope</dt>
          <dd>{ctx.scope}</dd>
          <dt className="label-caps pt-0.5 text-muted-foreground">Constraints</dt>
          <dd>
            <ul className="list-disc space-y-1 pl-4">
              {ctx.constraints.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </dd>
          <dt className="label-caps pt-0.5 text-muted-foreground">Decisions</dt>
          <dd>
            <ul className="list-disc space-y-1 pl-4">
              {ctx.decisions.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </dd>
        </dl>
      </details>
    </section>
  );
}
