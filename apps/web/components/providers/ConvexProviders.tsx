"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ConvexReactClient, useConvex, useConvexAuth } from "convex/react";
import { ConvexAuthNextjsProvider } from "@convex-dev/auth/nextjs";
import { useAuthActions } from "@convex-dev/auth/react";
import { CONVEX_URL } from "@/lib/config";
import { SessionContext, InvalidCredentialsError, type Session } from "@/lib/auth/useSession";
import { useStoredValue, writeStored } from "@/lib/storage";
import { TandemApiContext } from "@/lib/api";
import { createConvexApi } from "@/lib/api/convex";

// Convex Auth doesn't hand us a profile, so remember the email we signed in with
// for the header. Replace with a `users.viewer` query once Person 2 ships one.
const EMAIL_KEY = "tandem.session.email";

function ConvexSessionBridge({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { signIn, signOut } = useAuthActions();
  const email = useStoredValue(EMAIL_KEY);

  const session = useMemo<Session>(
    () => ({
      status: isLoading ? "loading" : isAuthenticated ? "authenticated" : "unauthenticated",
      user: isAuthenticated ? { email: email ?? "", name: email || "Signed in" } : null,
      async signIn(nextEmail, password) {
        try {
          await signIn("password", { email: nextEmail, password, flow: "signIn" });
        } catch {
          throw new InvalidCredentialsError();
        }
        writeStored(EMAIL_KEY, nextEmail);
      },
      async signOut() {
        await signOut();
        writeStored(EMAIL_KEY, null);
      },
    }),
    [isLoading, isAuthenticated, email, signIn, signOut],
  );

  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

function ConvexApiProvider({ children }: { children: ReactNode }) {
  const convex = useConvex();
  const api = useMemo(() => createConvexApi(convex), [convex]);
  return <TandemApiContext.Provider value={api}>{children}</TandemApiContext.Provider>;
}

export function ConvexProviders({ children }: { children: ReactNode }) {
  const [client] = useState(() => {
    if (!CONVEX_URL) {
      throw new Error(
        "NEXT_PUBLIC_CONVEX_URL is not set. Set it, or run with NEXT_PUBLIC_USE_MOCKS=true.",
      );
    }
    return new ConvexReactClient(CONVEX_URL);
  });

  return (
    <ConvexAuthNextjsProvider client={client}>
      <ConvexSessionBridge>
        <ConvexApiProvider>{children}</ConvexApiProvider>
      </ConvexSessionBridge>
    </ConvexAuthNextjsProvider>
  );
}
