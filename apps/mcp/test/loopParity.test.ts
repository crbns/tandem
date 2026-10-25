// The mock and Convex each keep their own copy of the loop guidance (Convex
// can't import from apps/mcp). This keeps the two copies identical.
import { describe, expect, it } from "vitest";
import * as mock from "../src/loop.js";

// Loaded by computed URL for the same reason as namesParity.test.ts (TS6059).
const CONVEX_LOOP = new URL(
  "../../../packages/backend/convex/lib/mcpLoop.ts",
  import.meta.url,
).href;
const convex = (await import(CONVEX_LOOP)) as typeof mock;

describe("loop guidance parity with Convex", () => {
  it("exports the same names", () => {
    expect(Object.keys(convex).sort()).toEqual(Object.keys(mock).sort());
  });

  it("sends the same instructions and next_steps", () => {
    const file = { id: "file_1", version: 3 };
    expect(mock.MCP_INSTRUCTIONS).toBe(convex.MCP_INSTRUCTIONS);
    expect(mock.syncNextSteps()).toEqual(convex.syncNextSteps());
    expect(mock.savedNextSteps(file)).toEqual(convex.savedNextSteps(file));
    expect(mock.publishedNextSteps()).toEqual(convex.publishedNextSteps());
    for (const deduplicated of [false, true])
      expect(mock.contextNextSteps(deduplicated)).toEqual(
        convex.contextNextSteps(deduplicated),
      );
  });
});
