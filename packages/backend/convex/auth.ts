import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";
import type { DataModel } from "./_generated/dataModel";

const EmailPassword = Password<DataModel>({
  profile(params) {
    const email = params.email;
    const name = params.name;
    if (typeof email !== "string" || !email.trim()) {
      throw new Error("Email is required.");
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
