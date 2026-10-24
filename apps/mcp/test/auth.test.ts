import { describe, expect, it } from "vitest";
import { DevTokenResolver, credentialHeader, withDevAnon } from "../src/auth.js";

describe("credentialHeader", () => {
  it("reads only api-key when bearer is off", () => {
    expect(credentialHeader({ authorization: "Bearer x" }, false)).toBeUndefined();
    expect(credentialHeader({ "api-key": "k" }, false)).toBe("k");
  });

  it("accepts Bearer or api-key, and rejects malformed or conflicting ones", () => {
    expect(credentialHeader({ authorization: "Bearer tok" }, true)).toBe("tok");
    expect(credentialHeader({ authorization: "bearer  tok " }, true)).toBe("tok");
    expect(credentialHeader({ "api-key": "tok" }, true)).toBe("tok");
    expect(credentialHeader({}, true)).toBeUndefined();
    expect(credentialHeader({ authorization: "Basic abc" }, true)).toBe("");
    expect(credentialHeader({ authorization: "Bearer a b" }, true)).toBe("");
    expect(
      credentialHeader({ authorization: "Bearer a", "api-key": "b" }, true),
    ).toBe("");
    expect(
      credentialHeader({ authorization: "Bearer a", "api-key": "a" }, true),
    ).toBe("a");
  });
});

describe("withDevAnon", () => {
  it("refuses anything but the mock backend", () => {
    expect(() =>
      withDevAnon(
        new DevTokenResolver(""),
        { TANDEM_DEV_ANON_USER: "user1", NODE_ENV: "development" },
        { kind: "convex" },
      ),
    ).toThrow(/only allowed with the mock backend/);
  });
});
