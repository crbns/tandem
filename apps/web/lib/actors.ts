import type { Actor } from "./api/types";

// Product names for the client ids the backend records. "other" has none, so
// the connection's own label is used instead.
const CLIENT_NAMES: Record<string, string> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
  gemini: "Gemini",
};

/** "Claude" for "claude"; unknown ids pass through, and "other" reads as "Other assistant". */
export function clientName(client: string): string {
  if (client === "other") return "Other assistant";
  return CLIENT_NAMES[client] ?? client;
}

/** The assistant behind an agent write: its client's product name, else the backend's label. */
function assistantName(actor: Actor): string {
  const known = actor.agentClient ? CLIENT_NAMES[actor.agentClient] : undefined;
  return known ?? actor.agentName ?? actor.agentClient ?? "An assistant";
}

/** The assistant's name for agents, the person's for humans. */
export function actorName(actor: Actor): string {
  if (actor.actorType === "agent") return assistantName(actor);
  return actor.userName ?? "A teammate";
}

/** For agents: whose assistant it is ("Alex"), when the backend says. */
export function onBehalfOf(actor: Actor): string | null {
  return actor.actorType === "agent" && actor.userName ? actor.userName : null;
}

/** For sentences, where a badge doesn't fit: "Alex via Claude", "Claude (agent)", "Alex". */
export function actorLabel(actor: Actor): string {
  if (actor.actorType === "human") return actorName(actor);
  const person = onBehalfOf(actor);
  return person ? `${person} via ${actorName(actor)}` : `${actorName(actor)} (agent)`;
}

/** User id the dashboard uses for the signed-in human. Mock mode records the same id. */
export function humanActorId(email: string): string {
  return `user_${email}`;
}
