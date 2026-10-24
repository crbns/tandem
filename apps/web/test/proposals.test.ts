import { describe, expect, it } from "vitest";
import { scopeReference } from "@/lib/proposals";

describe("scopeReference", () => {
  const scope = "In: emails. Out: a new help-center platform.";

  it("shows the approved scope beside additions, so a reviewer can check them against it", () => {
    expect(scopeReference("decision", scope)).toBe(scope);
    expect(scopeReference("constraint", scope)).toBe(scope);
    expect(scopeReference("ownership", scope)).toBe(scope);
  });

  it("leaves it off goal and scope changes (they show what they replace) and open questions", () => {
    expect(scopeReference("goal", scope)).toBeUndefined();
    expect(scopeReference("scope", scope)).toBeUndefined();
    expect(scopeReference("open_question", scope)).toBeUndefined();
  });

  it("leaves it off when no scope is approved yet", () => {
    expect(scopeReference("decision", "")).toBeUndefined();
    expect(scopeReference("decision", undefined)).toBeUndefined();
  });
});
