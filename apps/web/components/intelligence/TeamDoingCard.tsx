"use client";

import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { useObservedContext } from "@/lib/api/useIntelligence";
import type { ObservedEntry } from "@/lib/api/types";
import { ErrorState } from "@/components/common/ErrorState";
import { Skeleton } from "@/components/ui/skeleton";
import { EvidenceChip } from "./chips";
import { groupEntries, type GroupKey } from "./describe";

const SHOWN: ReadonlyArray<{ key: GroupKey; label: string }> = [
  { key: "in_progress", label: "In progress" },
  { key: "blocked", label: "Blocked" },
  { key: "completed", label: "Completed" },
];
const PER_GROUP = 3;

/** Overview: the top observed in-progress, blocked and completed work, linking to Live. */
export function TeamDoingCard({ workspaceId }: { workspaceId: string }) {
  const { resource, retry } = useObservedContext(workspaceId);
  return (
    <section aria-labelledby="team-doing" className="flex flex-col gap-3 rounded-md border bg-card px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <h2 id="team-doing" className="text-base font-semibold">
          What the team is doing
        </h2>
        <Link href={`/w/${workspaceId}/live`} className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
          Open Live
          <ArrowRightIcon aria-hidden className="size-3.5" />
        </Link>
      </div>
      {resource.status === "loading" && <Skeleton className="h-24" aria-label="Loading observed work" />}
      {resource.status === "error" && <ErrorState error={resource.error} onRetry={retry} />}
      {resource.status === "ready" && <Groups entries={resource.data.entries} />}
      <p className="text-xs text-muted-foreground">Observed from recorded activity by the context manager; not project context.</p>
    </section>
  );
}

function Groups({ entries }: { entries: ObservedEntry[] }) {
  const groups = groupEntries(entries);
  if (SHOWN.every(({ key }) => groups.get(key)!.length === 0))
    return <p className="text-sm text-muted-foreground">Nothing observed yet. Work appears here as assistants and people act in the workspace.</p>;
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {SHOWN.map(({ key, label }) => {
        const list = groups.get(key)!;
        return (
          <div key={key} className="flex min-w-0 flex-col gap-1.5">
            <h3 className="label-caps text-muted-foreground">
              {label} <span className="tabular-nums">{list.length}</span>
            </h3>
            {list.length === 0 ? (
              <p className="text-xs text-muted-foreground">None</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {list.slice(0, PER_GROUP).map((entry) => (
                  <li key={entry.id} className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm">{entry.title}</span>
                    <span className="flex items-center gap-1.5">
                      <EvidenceChip evidence={entry.evidence} />
                      {entry.agents[0] && <span className="truncate text-[0.6875rem] text-muted-foreground">{entry.agents[0].label}</span>}
                    </span>
                  </li>
                ))}
                {list.length > PER_GROUP && <li className="text-xs text-muted-foreground">and {list.length - PER_GROUP} more</li>}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
