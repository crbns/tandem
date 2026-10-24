"use client";

import { cn } from "@/lib/utils";

interface SegmentedControlProps<T extends string> {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  className?: string;
}

/**
 * A view switcher (e.g. Edit / Preview / Split). Toggle buttons with
 * aria-pressed rather than tabs, since there are no separate tab panels.
 */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("inline-flex h-8 w-fit items-center rounded-lg bg-muted p-[3px] text-muted-foreground", className)}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-pressed={opt.value === value}
          onClick={() => onChange(opt.value)}
          className={cn(
            "inline-flex h-full items-center rounded-md px-2.5 text-xs font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            opt.value === value && "bg-background text-foreground shadow-sm",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
