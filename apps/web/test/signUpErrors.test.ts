import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import {
  isAccountExistsError,
  isInvalidCredentialsError,
  isWeakPasswordError,
} from "@/lib/auth/signInErrors";

describe("sign-up error classification", () => {
  it("recognizes the backend's coded WEAK_PASSWORD error", () => {
    expect(isWeakPasswordError(new ConvexError({ code: "WEAK_PASSWORD", message: "Use at least 8 characters." }))).toBe(true);
  });

  it("recognizes the provider's default password check", () => {
    expect(isWeakPasswordError(new Error("[CONVEX A(auth:signIn)] Uncaught Error: Invalid password"))).toBe(true);
  });

  it("recognizes an existing account, without treating it as a weak password or bad login", () => {
    const err = new Error("[CONVEX A(auth:signIn)] Uncaught Error: Account sam@example.com already exists");
    expect(isAccountExistsError(err)).toBe(true);
    expect(isWeakPasswordError(err)).toBe(false);
    expect(isInvalidCredentialsError(err)).toBe(false);
  });

  it("leaves redacted server and network errors unclassified", () => {
    const redacted = new Error("[CONVEX A(auth:signIn)] [Request ID: 1] Server Error");
    expect(isAccountExistsError(redacted)).toBe(false);
    expect(isWeakPasswordError(redacted)).toBe(false);
    expect(isWeakPasswordError("Invalid password")).toBe(false);
  });
});
