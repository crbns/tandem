"use client";

import { useMemo, type ReactNode } from "react";
import { sideBySide, type DiffLine } from "@/lib/editor/lineDiff";
import { cn } from "@/lib/utils";

function Column({ title, lines, highlight }: { title: ReactNode; lines: DiffLine[]; highlight: string }) {
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-md border">
      <div className="flex items-center gap-2 border-b bg-muted/50 px-3 py-2 text-sm font-medium">{title}</div>
      <pre className="max-h-[55vh] overflow-auto py-2 font-mono text-xs leading-relaxed">
        {lines.length === 0 && <span className="px-3 text-muted-foreground italic">(empty)</span>}
        {lines.map((line, i) => (
          <div key={i} className={cn("whitespace-pre-wrap px-3", line.changed && highlight)}>
            {line.text || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}

interface DiffViewProps {
  left: { title: ReactNode; content: string };
  right: { title: ReactNode; content: string };
}

/** Side-by-side line diff. Lines only on the left are amber, only on the right are blue. */
export function DiffView({ left, right }: DiffViewProps) {
  const diff = useMemo(() => sideBySide(left.content, right.content), [left.content, right.content]);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Column title={left.title} lines={diff.mine} highlight="bg-amber-100" />
      <Column title={right.title} lines={diff.theirs} highlight="bg-sky-100" />
    </div>
  );
}
