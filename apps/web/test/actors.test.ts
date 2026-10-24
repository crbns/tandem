import { describe, expect, it } from "vitest";
import { actorLabel, actorName, onBehalfOf } from "@/lib/actors";
import { normalizeError } from "@/lib/api/errors";
import { ConvexError } from "convex/values";
import type { Actor } from "@/lib/api/types";

const alexsClaude: Actor = {
  actorType: "agent",
  userId: "user_alex",
  userName: "Alex",
  agentClient: "claude",
  agentName: "Claude",
};
const alex: Actor = { actorType: "human", userId: "user_alex", userName: "Alex" };

describe("actor display", () => {
  it("names an agent by its assistant and says whose it is", () => {
    expect(actorName(alexsClaude)).toBe("Claude");
    expect(onBehalfOf(alexsClaude)).toBe("Alex");
    expect(actorLabel(alexsClaude)).toBe("Claude for Alex");
  });

  it("falls back to the client id, then a generic name, when the agent name is missing", () => {
    expect(actorName({ actorType: "agent", userId: "u", agentClient: "chatgpt" })).toBe("chatgpt");
    expect(actorName({ actorType: "agent", userId: "u" })).toBe("An assistant");
    expect(actorLabel({ actorType: "agent", userId: "u", agentName: "Gemini" })).toBe("Gemini (agent)");
  });

  it("names a human by their own name, with no 'for'", () => {
    expect(actorName(alex)).toBe("Alex");
    expect(onBehalfOf(alex)).toBeNull();
    expect(actorLabel(alex)).toBe("Alex");
    expect(actorName({ actorType: "human", userId: "u" })).toBe("A teammate");
  });
});

describe("conflict author parsing", () => {
  it("reads person-plus-agent attribution from a ConvexError", () => {
    const err = normalizeError(
      new ConvexError({ code: "VERSION_CONFLICT", currentVersion: 2, updatedBy: { ...alexsClaude } as Record<string, string> }),
    );
    expect(err.details.updatedBy).toEqual(alexsClaude);
  });

  it("accepts MCP's snake_case conflict keys too, so either helper works", () => {
    const err = normalizeError(
      new ConvexError({
        code: "VERSION_CONFLICT",
        current_version: 3,
        current_content: "theirs",
        updated_by: { actor_type: "agent", user_id: "user_alex", client: "claude" },
      }),
    );
    expect(err.details.currentVersion).toBe(3);
    expect(err.details.currentContent).toBe("theirs");
    expect(err.details.updatedBy).toEqual({ actorType: "agent", userId: "user_alex", agentClient: "claude" });
  });
});
