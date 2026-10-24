import type { FileSummary } from "@/lib/api/types";
import { custodyMarks } from "@/lib/files";
import { CustodyMark } from "@/components/common/CustodyMark";

/** One mark per recent version, head mark one size larger, then the version tag. */
export function CustodyStrip({ file }: { file: FileSummary }) {
  const marks = custodyMarks(file);
  const agents = marks.filter((m) => m.kind === "agent").length;
  const humans = marks.filter((m) => m.kind === "human").length;
  return (
    <span
      className="inline-flex items-center gap-1"
      aria-label={`Version ${file.version}. Recent versions: ${agents} by agents, ${humans} by people.`}
    >
      {marks.map((m, i) => (
        <CustodyMark key={i} kind={m.kind} size={m.head ? "lg" : "sm"} />
      ))}
      <span aria-hidden className="label-caps ml-1.5 text-foreground">
        v{file.version}
      </span>
    </span>
  );
}
