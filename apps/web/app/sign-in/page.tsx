"use client";

import { Suspense, useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircleIcon, Loader2Icon } from "lucide-react";
import { useSession, InvalidCredentialsError } from "@/lib/auth/useSession";
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

function SignInForm() {
  const session = useSession();
  const router = useRouter();
  const rawNext = useSearchParams().get("next");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reaching sign-in completes any explicit sign-out.
  useEffect(() => endSignOut(), []);

  useEffect(() => {
    if (session.status === "authenticated") router.replace(safeNext(rawNext, window.location.origin));
  }, [session.status, rawNext, router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await session.signIn(email, password);
      // Keep this person's stashed drafts (a lost session), drop anyone else's.
      const owner = draftOwnerKey(email);
      if (owner) clearOtherUsersDraftStashes(owner);
    } catch (err) {
      setError(
        err instanceof InvalidCredentialsError
          ? err.message
          : "Couldn't reach Tandem. Check your connection and try again.",
      );
      setSubmitting(false);
    }
  }

  return (
    <Card className="w-full max-w-sm rounded-md shadow-none">
      <CardHeader>
        <CardTitle className="text-lg">Sign in</CardTitle>
        <CardDescription>Use the account your workspace admin gave you.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4">
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
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" disabled={submitting}>
            {submitting && <Loader2Icon className="animate-spin" />}
            Sign in
          </Button>
          {USE_MOCKS && (
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
