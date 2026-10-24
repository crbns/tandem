"use client";

import { AlertCircleIcon, RotateCwIcon } from "lucide-react";
import type { TandemApiError } from "@/lib/api";
import { ERROR_COPY } from "@/lib/api/errorCopy";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ErrorStateProps {
  error: TandemApiError;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({ error, onRetry, className }: ErrorStateProps) {
  const copy = ERROR_COPY[error.code];
  return (
    <Alert variant="destructive" className={cn("w-full", className)}>
      <AlertCircleIcon />
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription>
        <p>{copy.description}</p>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry} className="mt-2 text-foreground">
            <RotateCwIcon />
            Try again
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
