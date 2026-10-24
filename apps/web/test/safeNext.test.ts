import { describe, expect, it } from "vitest";
import { safeNext } from "@/lib/safeNext";

const ORIGIN = "https://app.tandem.dev";

describe("safeNext", () => {
  it("keeps same-origin paths with query and hash", () => {
    expect(safeNext("/w/ws_demo/files/f1?x=1#top", ORIGIN)).toBe("/w/ws_demo/files/f1?x=1#top");
  });

  it.each([
    null,
    "",
    "https://evil.com",
    "//evil.com",
    "/\\evil.com",
    "/\t/evil.com",
    "\\\\evil.com",
    "javascript:alert(1)",
    "w/relative",
  ])("falls back to / for %j", (next) => {
    expect(safeNext(next, ORIGIN)).toBe("/");
  });
});
