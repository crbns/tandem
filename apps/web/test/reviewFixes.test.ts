import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeError, TandemApiError } from "@/lib/api/errors";
import { draftStashKey } from "@/lib/editor/draftStash";
import { belongsToWorkspace } from "@/lib/files";
import { isInvalidCredentialsError } from "@/lib/auth/signInErrors";

describe("normalizeError logging", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs the cause of UNKNOWN errors once so demo failures leave a trace", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    normalizeError(new Error("contract mismatch: files:list returned _id"));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.join(" "))).toContain("contract mismatch");
  });

  it("does not log expected business errors", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    normalizeError(new TandemApiError("VERSION_CONFLICT", { currentVersion: 2, currentContent: "secret" }));
    normalizeError(new Error("Failed to fetch"));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("draftStashKey", () => {
  it("scopes stashed drafts to both the user and the file", () => {
    expect(draftStashKey("alex@x.dev", "f1")).not.toBe(draftStashKey("sam@x.dev", "f1"));
    expect(draftStashKey("alex@x.dev", "f1")).not.toBe(draftStashKey("alex@x.dev", "f2"));
    expect(draftStashKey("alex@x.dev", "f1").startsWith("tandem.draft.")).toBe(true);
  });
});

describe("belongsToWorkspace", () => {
  it("rejects a file opened under another workspace's URL", () => {
    expect(belongsToWorkspace({ workspaceId: "wsB" }, "wsA")).toBe(false);
    expect(belongsToWorkspace({ workspaceId: "wsA" }, "wsA")).toBe(true);
  });
});

describe("isInvalidCredentialsError", () => {
  it.each(["InvalidSecret", "InvalidAccountId", "Uncaught Error: InvalidSecret at ..."])(
    "treats %j as bad credentials",
    (message) => {
      expect(isInvalidCredentialsError(new Error(message))).toBe(true);
    },
  );

  it("treats network and unknown failures as not-credentials", () => {
    expect(isInvalidCredentialsError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isInvalidCredentialsError(new Error("Server Error"))).toBe(false);
    expect(isInvalidCredentialsError("nope")).toBe(false);
  });
});
