import type { ActivitySource, EvidenceLevel, ObservedEntry } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { EVIDENCE_META, SOURCE_META, payloadRows, severityLabel } from "./describe";

const CHIP = "inline-flex shrink-0 items-center whitespace-nowrap rounded-sm border px-1.5 py-px text-[0.6875rem] font-medium leading-4";

export function EvidenceChip({ evidence, className }: { evidence: EvidenceLevel; className?: string }) {
  const meta = EVIDENCE_META[evidence];
  return (
    <span title={meta.title} className={cn(CHIP, meta.className, className)}>
      <span className="sr-only">Evidence: </span>
      {meta.label}
    </span>
  );
}

export function SourceBadge({ source, className }: { source: ActivitySource; className?: string }) {
  const meta = SOURCE_META[source];
  return (
    <span className={cn(CHIP, meta.className, className)}>
      <span className="sr-only">Source: </span>
      {meta.label}
    </span>
  );
}

export function SeverityChip({ severity }: { severity: ObservedEntry["severity"] }) {
  const label = severityLabel(severity);
  if (!label) return null;
  return (
    <span
      className={cn(
        CHIP,
        severity === "actual" ? "border-destructive/40 bg-destructive/[0.06] text-destructive" : "border-dashed border-warn-rule text-warn",
      )}
    >
      {label}
    </span>
  );
}

/** "82%": the context manager's own estimate, not a guarantee. */
export function Confidence({ value }: { value: number }) {
  return (
    <span title="The context manager's own confidence estimate" className="text-[0.6875rem] tabular-nums text-muted-foreground">
      {Math.round(Math.min(1, Math.max(0, value)) * 100)}%<span className="sr-only"> confidence</span>
    </span>
  );
}

/** The redacted payload as key/value rows. Untrusted text: rendered, never interpreted. */
export function PayloadView({ payload }: { payload: string | null }) {
  const rows = payloadRows(payload);
  if (rows.length === 0) return <p className="text-xs text-muted-foreground">No details were recorded.</p>;
  return (
    <dl className="grid grid-cols-[minmax(5rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-sm border bg-background/60 px-3 py-2 font-mono text-[0.6875rem]">
      {rows.map(([key, value], index) => (
        <div key={`${key}-${index}`} className="contents">
          <dt className="truncate text-muted-foreground">{key}</dt>
          <dd className="min-w-0 whitespace-pre-wrap break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
