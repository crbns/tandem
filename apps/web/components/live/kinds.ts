import {
  BookOpenIcon,
  CheckCheckIcon,
  CircleXIcon,
  EyeIcon,
  FileTextIcon,
  GitPullRequestArrowIcon,
  ListChecksIcon,
  OctagonAlertIcon,
  PencilLineIcon,
  RefreshCwIcon,
  SendIcon,
  StampIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import type { ActivityKind } from "@/lib/api/types";

/**
 * One colour per kind of traffic: slate for syncs, a lighter slate for reads,
 * verdigris for what assistants send in, deep red for conflicts, ochre for
 * errors, ink-blue for people's decisions. `stroke` is a CSS colour for SVG.
 */
export const KIND_STYLE: Record<ActivityKind, { icon: LucideIcon; text: string; stroke: string }> = {
  sync: { icon: RefreshCwIcon, text: "text-archive", stroke: "var(--archive)" },
  read: { icon: EyeIcon, text: "text-read", stroke: "var(--read)" },
  write: { icon: PencilLineIcon, text: "text-agent", stroke: "var(--agent)" },
  propose: { icon: GitPullRequestArrowIcon, text: "text-agent", stroke: "var(--agent)" },
  publish: { icon: SendIcon, text: "text-agent", stroke: "var(--agent)" },
  task: { icon: ListChecksIcon, text: "text-agent", stroke: "var(--agent)" },
  resolved: { icon: CheckCheckIcon, text: "text-agent", stroke: "var(--agent)" },
  conflict: { icon: TriangleAlertIcon, text: "text-destructive", stroke: "var(--destructive)" },
  error: { icon: OctagonAlertIcon, text: "text-warn", stroke: "var(--warn)" },
  approve: { icon: StampIcon, text: "text-human", stroke: "var(--human)" },
  reject: { icon: CircleXIcon, text: "text-human", stroke: "var(--human)" },
  context: { icon: BookOpenIcon, text: "text-human", stroke: "var(--human)" },
  human_edit: { icon: FileTextIcon, text: "text-human", stroke: "var(--human)" },
};
