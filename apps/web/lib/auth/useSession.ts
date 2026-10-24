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
  /**
   * Creates a Password account and signs in. Rejects with
   * {@link WeakPasswordError} or {@link AccountExistsError} when the backend
   * says so; anything else propagates.
   */
  signUp(name: string, email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
}

/** Keep in sync with MIN_PASSWORD_LENGTH in packages/backend/convex/auth.ts. */
export const MIN_PASSWORD_LENGTH = 8;

export class InvalidCredentialsError extends Error {
  constructor() {
    super("Email or password is incorrect.");
    this.name = "InvalidCredentialsError";
  }
}

export class WeakPasswordError extends Error {
  constructor() {
    super(`Use a password with at least ${MIN_PASSWORD_LENGTH} characters.`);
    this.name = "WeakPasswordError";
  }
}

export class AccountExistsError extends Error {
  constructor() {
    super("An account with this email already exists. Sign in instead.");
    this.name = "AccountExistsError";
  }
}

export const SessionContext = createContext<Session | null>(null);

/** Wraps Convex Auth (real mode) or the fake mock session behind one shape. */
export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside <Providers>");
  return session;
}
