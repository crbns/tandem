import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import { normalizeError, TandemApiError } from "@/lib/api/errors";

describe("normalizeError", () => {
  it("maps a ConvexError VERSION_CONFLICT and carries the current version", () => {
    const err = normalizeError(new ConvexError({ code: "VERSION_CONFLICT", currentVersion: 3 }));
    expect(err).toBeInstanceOf(TandemApiError);
    expect(err.code).toBe("VERSION_CONFLICT");
    expect(err.details.currentVersion).toBe(3);
  });

  it("carries the latest content and author on a conflict when the backend sends them", () => {
    const err = normalizeError(
      new ConvexError({
        code: "VERSION_CONFLICT",
        currentVersion: 4,
        currentContent: "# theirs",
        updatedBy: { actorType: "agent", userId: "user_alex", agentClient: "claude", agentName: "Claude" },
      }),
    );
    expect(err.details.currentContent).toBe("# theirs");
    expect(err.details.updatedBy).toEqual({
      actorType: "agent",
      userId: "user_alex",
      agentClient: "claude",
      agentName: "Claude",
    });
  });

  it.each(["FORBIDDEN", "FILE_NOT_FOUND", "UNAUTHENTICATED"] as const)(
    "maps ConvexError code %s",
    (code) => {
      expect(normalizeError(new ConvexError({ code })).code).toBe(code);
    },
  );

  it("maps a ConvexError whose data is the bare code string", () => {
    expect(normalizeError(new ConvexError("VERSION_CONFLICT")).code).toBe("VERSION_CONFLICT");
  });

  it("maps an unrecognised ConvexError code to UNKNOWN", () => {
    expect(normalizeError(new ConvexError({ code: "TEAPOT" })).code).toBe("UNKNOWN");
  });

  it("maps Convex's missing-function error to NOT_IMPLEMENTED", () => {
    const err = normalizeError(
      new Error("[CONVEX Q(files:list)] Server Error\nCould not find public function for 'files:list'."),
    );
    expect(err.code).toBe("NOT_IMPLEMENTED");
  });

  it("maps an unauthenticated server error to UNAUTHENTICATED", () => {
    const err = normalizeError(
      new Error("[CONVEX M(files:updateContent)] Uncaught Error: Not authenticated"),
    );
    expect(err.code).toBe("UNAUTHENTICATED");
  });

  it("maps a fetch failure to NETWORK", () => {
    expect(normalizeError(new TypeError("Failed to fetch")).code).toBe("NETWORK");
  });

  it("maps unknown errors and non-Error values to UNKNOWN", () => {
    expect(normalizeError(new Error("boom")).code).toBe("UNKNOWN");
    expect(normalizeError("boom").code).toBe("UNKNOWN");
  });

  it("passes an already-normalized error through unchanged", () => {
    const original = new TandemApiError("FORBIDDEN");
    expect(normalizeError(original)).toBe(original);
  });
});
