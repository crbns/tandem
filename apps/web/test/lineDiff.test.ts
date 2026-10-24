import { describe, expect, it } from "vitest";
import { sideBySide } from "@/lib/editor/lineDiff";

describe("sideBySide", () => {
  it("marks lines only in mine on the left and lines only in theirs on the right", () => {
    const { mine, theirs } = sideBySide("a\nmine only\nc\n", "a\ntheirs only\nc\n");
    expect(mine).toEqual([
      { text: "a", changed: false },
      { text: "mine only", changed: true },
      { text: "c", changed: false },
    ]);
    expect(theirs).toEqual([
      { text: "a", changed: false },
      { text: "theirs only", changed: true },
      { text: "c", changed: false },
    ]);
  });

  it("handles identical text and text without a trailing newline", () => {
    const { mine, theirs } = sideBySide("x\ny", "x\ny");
    expect(mine.every((l) => !l.changed)).toBe(true);
    expect(theirs.map((l) => l.text)).toEqual(["x", "y"]);
  });

  it("keeps blank lines", () => {
    expect(sideBySide("a\n\nb\n", "a\n\nb\n").mine.map((l) => l.text)).toEqual(["a", "", "b"]);
  });
});
