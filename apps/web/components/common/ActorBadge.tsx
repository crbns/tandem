import type { Actor } from "@/lib/api/types";
import { CustodyMark } from "@/components/common/CustodyMark";
import { cn } from "@/lib/utils";

/**
 * Identity plate: one fixed form for every actor, everywhere: mark, catalogue
 * label (AGENT / HUMAN), name. Attribution only, never presence.
 */
export function ActorBadge({ actor, className }: { actor: Actor; className?: string }) {
  const isAgent = actor.actorType === "agent";
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap", className)}>
      <CustodyMark kind={actor.actorType} />
      <span className={cn("label-caps", isAgent ? "text-agent" : "text-human")}>
        {isAgent ? "Agent" : "Human"}
      </span>
      <span className="truncate font-medium text-foreground">
        {actor.actorName ?? (isAgent ? "Assistant" : "Teammate")}
      </span>
    </span>
  );
}
