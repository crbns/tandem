import { describe, expect, it } from "vitest";
import { createMockApi, MOCK_WORKSPACE_ID } from "@/lib/api/mock";
import { TandemApiError } from "@/lib/api/errors";
import type { Actor } from "@/lib/api/types";

const human: Actor = { actorType: "human", userId: "u", userName: "Demo Human" };

describe("mock getContext", () => {
  it("returns the approved project context with who approved it", async () => {
    const api = createMockApi({ latencyMs: [0, 0], getActor: () => human });
    const ctx = await api.getContext(MOCK_WORKSPACE_ID);
    expect(ctx?.goal).toMatch(/\S/);
    expect(ctx?.version).toBeGreaterThanOrEqual(1);
    expect(ctx?.approvedBy.actorType).toBe("human");
    expect(Array.isArray(ctx?.decisions)).toBe(true);
    expect(Array.isArray(ctx?.constraints)).toBe(true);
  });

  it("refuses a workspace the user isn't in", async () => {
    const api = createMockApi({ latencyMs: [0, 0], getActor: () => human });
    const err = await api.getContext("ws_other").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TandemApiError);
    expect((err as TandemApiError).code).toBe("FORBIDDEN");
  });
});
