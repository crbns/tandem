"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AlertCircleIcon, Loader2Icon, RotateCwIcon } from "lucide-react";
import type { TandemApiError } from "@/lib/api";
import { ERROR_COPY } from "@/lib/api/errorCopy";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ErrorStateProps {
  error: TandemApiError;
  onRetry?: () => void;
  /** A retry is in flight: disable the button so clicks don't pile up requests. */
  retrying?: boolean;
  className?: string;
}

export function ErrorState({ error, onRetry, retrying, className }: ErrorStateProps) {
  const router = useRouter();
  const pathname = usePathname();
  const unauthenticated = error.code === "UNAUTHENTICATED";

  // A signed-out load can't be retried into success: send them to sign in.
  useEffect(() => {
    if (unauthenticated) router.replace(`/sign-in?next=${encodeURIComponent(pathname)}`);
  }, [unauthenticated, pathname, router]);

  const copy = unauthenticated
    ? { title: "You've been signed out", description: "Taking you to sign in…" }
    : ERROR_COPY[error.code];

  return (
    <Alert variant="destructive" className={cn("w-full", className)}>
      <AlertCircleIcon />
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription>
        <p>{copy.description}</p>
        {onRetry && !unauthenticated && (
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            disabled={retrying}
            className="mt-2 text-foreground"
          >
            {retrying ? <Loader2Icon className="animate-spin" /> : <RotateCwIcon />}
            Try again
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
