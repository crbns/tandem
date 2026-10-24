"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  SessionContext,
  AccountExistsError,
  InvalidCredentialsError,
  MIN_PASSWORD_LENGTH,
  WeakPasswordError,
  type Session,
  type SessionUser,
} from "@/lib/auth/useSession";
import { MOCK_USERS, findMockUser } from "@/lib/auth/mockUsers";
import { useStoredValue, writeStored } from "@/lib/storage";
import { MockApiContext, TandemApiContext, type Actor } from "@/lib/api";
import { createMockApi } from "@/lib/api/mock";
import { humanActorId } from "@/lib/actors";

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

function actorFor(user: SessionUser | null): Actor {
  return user
    ? { actorType: "human", userId: humanActorId(user.email), userName: user.name }
    : { actorType: "human", userId: "user_anonymous", userName: "Unknown" };
}

export function MockProviders({ children }: { children: ReactNode }) {
  const raw = useStoredValue(SESSION_KEY);
  const user = useMemo(() => (raw === undefined ? null : parseUser(raw)), [raw]);

  // The mock store lives as long as this provider (i.e. until a full reload).
  const actorRef = useRef<Actor>(actorFor(null));
  const [api] = useState(() => createMockApi({ getActor: () => actorRef.current }));
  useEffect(() => {
    actorRef.current = actorFor(user);
  }, [user]);

  const session = useMemo<Session>(
    () => ({
      status: raw === undefined ? "loading" : user ? "authenticated" : "unauthenticated",
      user,
      async signIn(email, password) {
        await new Promise((r) => setTimeout(r, 250));
        const found = findMockUser(email, password);
        if (!found) throw new InvalidCredentialsError();
        writeStored(SESSION_KEY, JSON.stringify(found));
      },
      // Mock accounts aren't stored: a mock sign-up just signs in as the new person.
      async signUp(name, email, password) {
        await new Promise((r) => setTimeout(r, 250));
        if (password.length < MIN_PASSWORD_LENGTH) throw new WeakPasswordError();
        const normalized = email.trim().toLowerCase();
        if (MOCK_USERS.some((u) => u.email.toLowerCase() === normalized)) throw new AccountExistsError();
        const created: SessionUser = { email: normalized, name: name.trim() || (normalized.split("@")[0] ?? normalized) };
        writeStored(SESSION_KEY, JSON.stringify(created));
      },
      async signOut() {
        writeStored(SESSION_KEY, null);
      },
    }),
    [raw, user],
  );

  return (
    <SessionContext.Provider value={session}>
      <TandemApiContext.Provider value={api}>
        <MockApiContext.Provider value={api}>{children}</MockApiContext.Provider>
      </TandemApiContext.Provider>
    </SessionContext.Provider>
  );
}
