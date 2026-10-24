import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { DataModel } from "./_generated/dataModel";

export const MIN_PASSWORD_LENGTH = 8;

const EmailPassword = Password<DataModel>({
  // Coded errors survive production deployments, which redact plain Error
  // messages, so the sign-up form can say what to fix.
  validatePasswordRequirements(password) {
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new ConvexError({
        code: "WEAK_PASSWORD",
        message: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
      });
    }
  },
  profile(params) {
    const email = params.email;
    const name = params.name;
    if (typeof email !== "string" || !email.trim()) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "Email is required." });
    }
    const normalizedEmail = email.trim().toLowerCase();
    return {
      email: normalizedEmail,
      name:
        typeof name === "string" && name.trim()
          ? name.trim()
          : normalizedEmail.split("@")[0],
    };
  },
});

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [EmailPassword],
});
