import type { ActorType } from "@/lib/api/types";
import { cn } from "@/lib/utils";

/**
 * The custody mark: agents are squares (verdigris), humans are circles
 * (ink-blue), unrecorded earlier versions are hollow squares. Shape carries the
 * identity as well as colour, so it reads without colour vision.
 */
export function CustodyMark({
  kind,
  size = "sm",
  className,
}: {
  kind: ActorType | "unknown";
  size?: "sm" | "lg";
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block shrink-0",
        size === "sm" ? "size-2" : "size-3",
        kind === "agent" && "bg-agent",
        kind === "human" && "rounded-full bg-human",
        kind === "unknown" && "border border-unknown",
        className,
      )}
    />
  );
}
