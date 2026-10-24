"use client";

import { useMemo, type ReactNode } from "react";
import { sideBySide, type DiffLine } from "@/lib/editor/lineDiff";
import { cn } from "@/lib/utils";

interface Side {
  title: ReactNode;
  content: string;
}

function Column({
  title,
  lines,
  marker,
  srLabel,
  highlight,
}: {
  title: ReactNode;
  lines: DiffLine[];
  marker: string;
  srLabel: string;
  highlight: string;
}) {
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-md border">
      <div className="flex items-center gap-2 border-b bg-muted/50 px-3 py-2 text-sm font-medium">{title}</div>
      <pre className="max-h-[55vh] overflow-auto py-2 font-mono text-xs leading-relaxed">
        {lines.length === 0 && <span className="px-3 text-muted-foreground italic">(empty)</span>}
        {lines.map((line, i) => (
          <div key={i} className={cn("flex whitespace-pre-wrap", line.changed && highlight)}>
            {/* Marker + hidden label so the difference isn't conveyed by colour alone. */}
            <span aria-hidden className="w-5 shrink-0 select-none text-center text-muted-foreground">
              {line.changed ? marker : ""}
            </span>
            {line.changed && <span className="sr-only">{srLabel}: </span>}
            <span className="min-w-0 flex-1 pr-3">{line.text || " "}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

/** Side-by-side line diff: `old` on the left, `new` on the right. */
export function DiffView({ left, right }: { left: Side; right: Side }) {
  const diff = useMemo(() => sideBySide(left.content, right.content), [left.content, right.content]);
  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-4 lg:grid-cols-2">
        <Column title={left.title} lines={diff.mine} marker="−" srLabel="Only on the left" highlight="bg-amber-100" />
        <Column title={right.title} lines={diff.theirs} marker="+" srLabel="Only on the right" highlight="bg-sky-100" />
      </div>
      <p className="text-xs text-muted-foreground">
        Lines marked <span className="font-mono">−</span> exist only on the left,{" "}
        <span className="font-mono">+</span> only on the right.
      </p>
    </div>
  );
}
