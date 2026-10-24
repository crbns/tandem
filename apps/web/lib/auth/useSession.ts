"use client";

import { createContext, useContext } from "react";

export interface SessionUser {
  name: string;
  email: string;
}

export type SessionStatus = "loading" | "authenticated" | "unauthenticated";

export interface Session {
  status: SessionStatus;
  user: SessionUser | null;
  /** Rejects with {@link InvalidCredentialsError} on a bad email/password. */
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super("Email or password is incorrect.");
    this.name = "InvalidCredentialsError";
  }
}

export const SessionContext = createContext<Session | null>(null);

/** Wraps Convex Auth (real mode) or the fake mock session behind one shape. */
export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside <Providers>");
  return session;
}
