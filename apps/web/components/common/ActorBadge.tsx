import type { Actor } from "@/lib/api/types";
import { actorName, onBehalfOf } from "@/lib/actors";
import { CustodyMark } from "@/components/common/CustodyMark";
import { cn } from "@/lib/utils";

/**
 * Identity plate: one fixed form for every actor, everywhere: mark, catalogue
 * label (AGENT / HUMAN), then the name. An agent write names the person whose
 * assistant it was, "Alex via Claude". Attribution only, never presence.
 */
export function ActorBadge({ actor, className }: { actor: Actor; className?: string }) {
  const isAgent = actor.actorType === "agent";
  const person = onBehalfOf(actor);
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap", className)}>
      <CustodyMark kind={actor.actorType} />
      <span className={cn("label-caps", isAgent ? "text-agent" : "text-human")}>
        {isAgent ? "Agent" : "Human"}
      </span>
      <span className="truncate font-medium text-foreground">
        {person ?? actorName(actor)}
        {person && <span className="font-normal text-muted-foreground"> via {actorName(actor)}</span>}
      </span>
    </span>
  );
}
