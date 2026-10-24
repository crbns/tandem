"use client";

import { useMemo, type ReactNode } from "react";
import { SessionContext, InvalidCredentialsError, type Session, type SessionUser } from "@/lib/auth/useSession";
import { findMockUser } from "@/lib/auth/mockUsers";
import { useStoredValue, writeStored } from "@/lib/storage";

const SESSION_KEY = "tandem.mock.session";

function parseUser(raw: string | null): SessionUser | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      value &&
      typeof value === "object" &&
      "name" in value &&
      "email" in value &&
      typeof value.name === "string" &&
      typeof value.email === "string"
    ) {
      return { name: value.name, email: value.email };
    }
  } catch {
    // fall through
  }
  return null;
}

export function MockProviders({ children }: { children: ReactNode }) {
  const raw = useStoredValue(SESSION_KEY);

  const session = useMemo<Session>(() => {
    const user = raw === undefined ? null : parseUser(raw);
    return {
      status: raw === undefined ? "loading" : user ? "authenticated" : "unauthenticated",
      user,
      async signIn(email, password) {
        await new Promise((r) => setTimeout(r, 250));
        const found = findMockUser(email, password);
        if (!found) throw new InvalidCredentialsError();
        writeStored(SESSION_KEY, JSON.stringify(found));
      },
      async signOut() {
        writeStored(SESSION_KEY, null);
      },
    };
  }, [raw]);

  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}
