import { BotIcon, UserIcon } from "lucide-react";
import type { Actor } from "@/lib/api/types";
import { cn } from "@/lib/utils";

/** "Agent · Claude" / "Human · Alex". Attribution only, never presence. */
export function ActorBadge({ actor, className }: { actor: Actor; className?: string }) {
  const isAgent = actor.actorType === "agent";
  const Icon = isAgent ? BotIcon : UserIcon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-xs",
        isAgent ? "border-violet-200 bg-violet-50 text-violet-800" : "border-sky-200 bg-sky-50 text-sky-800",
        className,
      )}
    >
      <Icon className="size-3" />
      <span className="font-medium">{isAgent ? "Agent" : "Human"}</span>
      <span aria-hidden>·</span>
      <span>{actor.actorName ?? (isAgent ? "Assistant" : "Teammate")}</span>
    </span>
  );
}
