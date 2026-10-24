"use client";

import { Suspense, useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircleIcon, Loader2Icon } from "lucide-react";
import {
  useSession,
  AccountExistsError,
  InvalidCredentialsError,
  MIN_PASSWORD_LENGTH,
  WeakPasswordError,
} from "@/lib/auth/useSession";
import { USE_MOCKS } from "@/lib/config";
import { MOCK_USERS } from "@/lib/auth/mockUsers";
import { safeNext } from "@/lib/safeNext";
import { endSignOut } from "@/lib/auth/signOutIntent";
import { TandemMark } from "@/components/common/TandemMark";
import { clearOtherUsersDraftStashes, draftOwnerKey } from "@/lib/editor/draftStash";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Mode = "sign-in" | "sign-up";

function SignInForm() {
  const session = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const rawNext = params.get("next");
  const [mode, setMode] = useState<Mode>(params.get("mode") === "sign-up" ? "sign-up" : "sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signingUp = mode === "sign-up";

  // Reaching sign-in completes any explicit sign-out.
  useEffect(() => endSignOut(), []);

  useEffect(() => {
    if (session.status === "authenticated") router.replace(safeNext(rawNext, window.location.origin));
  }, [session.status, rawNext, router]);

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (signingUp) await session.signUp(name, email, password);
      else await session.signIn(email, password);
      // Keep this person's stashed drafts (a lost session), drop anyone else's.
      const owner = draftOwnerKey(email);
      if (owner) clearOtherUsersDraftStashes(owner);
    } catch (err) {
      setError(
        err instanceof InvalidCredentialsError ||
          err instanceof WeakPasswordError ||
          err instanceof AccountExistsError
          ? err.message
          : signingUp
            ? // Production deployments redact "account already exists", so it lands here too.
              "Couldn't create the account. If you already have one, sign in instead; otherwise check your connection and try again."
            : "Couldn't reach Tandem. Check your connection and try again.",
      );
      setSubmitting(false);
    }
  }

  return (
    <Card className="w-full max-w-sm rounded-md shadow-none">
      <CardHeader>
        <CardTitle className="text-lg">{signingUp ? "Create your account" : "Sign in"}</CardTitle>
        <CardDescription>
          {signingUp
            ? "Then create a workspace, or open the invite link a teammate sent you."
            : "Sign in with your Tandem email and password."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4">
          {signingUp && (
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                autoComplete="name"
                required
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete={signingUp ? "new-password" : "current-password"}
              required
              minLength={signingUp ? MIN_PASSWORD_LENGTH : undefined}
              aria-describedby={signingUp ? "password-hint" : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {signingUp && (
              <p id="password-hint" className="text-xs text-muted-foreground">
                At least {MIN_PASSWORD_LENGTH} characters.
              </p>
            )}
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" disabled={submitting}>
            {submitting && <Loader2Icon className="animate-spin" />}
            {signingUp ? "Create account" : "Sign in"}
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            {signingUp ? "Already have an account? " : "New to Tandem? "}
            <button
              type="button"
              disabled={submitting}
              className="font-medium text-foreground underline underline-offset-4 disabled:opacity-50"
              onClick={() => switchMode(signingUp ? "sign-in" : "sign-up")}
            >
              {signingUp ? "Sign in" : "Create an account"}
            </button>
          </p>
          {USE_MOCKS && !signingUp && (
            <p className="text-xs text-muted-foreground">
              Mock mode: sign in as <code>{MOCK_USERS[0]?.email}</code> /{" "}
              <code>{MOCK_USERS[0]?.password}</code>.
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

export default function SignInPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-background px-4 py-12">
      <div className="flex flex-col items-center gap-3 text-center">
        <TandemMark className="size-10" />
        <p className="text-2xl font-bold tracking-[-0.01em]">Tandem</p>
        <p className="max-w-xs text-sm text-muted-foreground">
          Shared files for people. Shared understanding for their AI assistants.
        </p>
      </div>
      <Suspense>
        <SignInForm />
      </Suspense>
    </main>
  );
}
