import { cn } from "@/lib/utils";

/** Two overlapping sheets: one file, two holders. */
export function TandemMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 28" aria-hidden className={cn("size-7 shrink-0 text-archive", className)}>
      <rect x="2.5" y="6" width="14" height="16" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="11.5" y="6" width="14" height="16" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
