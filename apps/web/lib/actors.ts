import type { Actor } from "./api/types";

/** "Claude (agent)" / "Alex": for sentences, where a badge doesn't fit. */
export function actorLabel(actor: Actor): string {
  const name = actor.actorName ?? (actor.actorType === "agent" ? "An assistant" : "A teammate");
  return actor.actorType === "agent" ? `${name} (agent)` : name;
}

/** Actor id the dashboard uses for the signed-in human. Mock mode records the same id. */
export function humanActorId(email: string): string {
  return `user_${email}`;
}
