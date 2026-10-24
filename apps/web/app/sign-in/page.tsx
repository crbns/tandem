"use client";

import { Suspense, useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircleIcon, Loader2Icon } from "lucide-react";
import { useSession, InvalidCredentialsError } from "@/lib/auth/useSession";
import { USE_MOCKS } from "@/lib/config";
import { MOCK_USERS } from "@/lib/auth/mockUsers";
import { safeNext } from "@/lib/safeNext";
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

  useEffect(() => {
    if (session.status === "authenticated") router.replace(safeNext(rawNext, window.location.origin));
  }, [session.status, rawNext, router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await session.signIn(email, password);
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
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-xl">Sign in to Tandem</CardTitle>
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
    <main className="flex min-h-screen items-center justify-center bg-sidebar px-4">
      <Suspense>
        <SignInForm />
      </Suspense>
    </main>
  );
}
