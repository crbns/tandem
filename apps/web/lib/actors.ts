import type { Actor } from "./api/types";

/** The name on the identity plate: the assistant for agents, the person for humans. */
export function actorName(actor: Actor): string {
  if (actor.actorType === "agent") return actor.agentName ?? actor.agentClient ?? "An assistant";
  return actor.userName ?? "A teammate";
}

/** For agents: whose assistant it is ("Alex"), when the backend says. */
export function onBehalfOf(actor: Actor): string | null {
  return actor.actorType === "agent" && actor.userName ? actor.userName : null;
}

/** For sentences, where a badge doesn't fit: "Claude for Alex", "Claude (agent)", "Alex". */
export function actorLabel(actor: Actor): string {
  if (actor.actorType === "human") return actorName(actor);
  const person = onBehalfOf(actor);
  return person ? `${actorName(actor)} for ${person}` : `${actorName(actor)} (agent)`;
}

/** User id the dashboard uses for the signed-in human. Mock mode records the same id. */
export function humanActorId(email: string): string {
  return `user_${email}`;
}
