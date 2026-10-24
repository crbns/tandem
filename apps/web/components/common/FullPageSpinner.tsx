import { Loader2Icon } from "lucide-react";

export function FullPageSpinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2Icon className="size-4 animate-spin" />
      {label}
    </div>
  );
}
