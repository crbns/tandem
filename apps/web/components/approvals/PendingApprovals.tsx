"use client";

import { useCallback } from "react";
import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { useTandemApi } from "@/lib/api";
import { useResource } from "@/lib/api/useResource";
import { useWorkspaceRefresh } from "@/lib/api/useWorkspace";
import { FIELD_LABELS } from "@/lib/proposals";
import { ActorBadge } from "@/components/common/ActorBadge";

const SHOWN = 3;

export const approvalsHref = (workspaceId: string) => `/w/${workspaceId}/approvals`;

/**
 * Pending context proposals on the workspace home. Silent when nothing is
 * waiting or the list can't load: the approvals page has the full story.
 */
export function PendingApprovals({ workspaceId }: { workspaceId: string }) {
  const api = useTandemApi();
  const load = useCallback(() => api.listProposals(workspaceId, "pending"), [api, workspaceId]);
  const { resource, reload } = useResource(load);
  useWorkspaceRefresh(workspaceId, reload);

  if (resource.status !== "ready" || resource.data.length === 0) return null;
  const pending = resource.data;

  return (
    <section aria-labelledby="pending-approvals-heading" className="rounded-md border border-warn-rule bg-card px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id="pending-approvals-heading" className="text-sm font-semibold">
          {pending.length === 1 ? "1 proposal waits for approval" : `${pending.length} proposals wait for approval`}
        </h2>
        <Link
          href={approvalsHref(workspaceId)}
          className="ml-auto inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          Review approvals
          <ArrowRightIcon className="size-3.5" aria-hidden />
        </Link>
      </div>
      <ul className="mt-2 flex flex-col gap-1.5 text-sm">
        {pending.slice(0, SHOWN).map((p) => (
          <li key={p.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="label-caps text-muted-foreground">{FIELD_LABELS[p.field]}</span>
            <span className="min-w-0 flex-1 truncate">{p.proposedValue}</span>
            <ActorBadge actor={p.createdBy} className="text-xs" />
          </li>
        ))}
      </ul>
      {pending.length > SHOWN && (
        <p className="mt-1.5 text-xs text-muted-foreground">and {pending.length - SHOWN} more</p>
      )}
    </section>
  );
}
