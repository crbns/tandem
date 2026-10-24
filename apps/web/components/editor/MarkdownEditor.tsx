"use client";

import type { Ref } from "react";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { MarkdownPreview } from "@/components/editor/MarkdownPreview";
import { cn } from "@/lib/utils";

export type EditorView = "edit" | "preview" | "split";

const VIEW_OPTIONS = [
  { value: "edit", label: "Edit" },
  { value: "preview", label: "Preview" },
  { value: "split", label: "Split" },
] as const;

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Plain text files get the textarea only. */
  markdown: boolean;
  /** Owned by the parent so it survives the editor unmounting during a conflict. */
  view: EditorView;
  onViewChange: (view: EditorView) => void;
  readOnly?: boolean;
  /** Focus the textarea on mount (e.g. returning from the conflict panel). */
  autoFocus?: boolean;
  textareaRef?: Ref<HTMLTextAreaElement>;
}

export function MarkdownEditor({
  value,
  onChange,
  markdown,
  view,
  onViewChange,
  readOnly,
  autoFocus,
  textareaRef,
}: MarkdownEditorProps) {
  const effective: EditorView = markdown ? view : "edit";

  return (
    <div className="flex flex-col gap-2">
      {markdown && (
        <SegmentedControl label="Editor view" value={view} options={VIEW_OPTIONS} onChange={onViewChange} />
      )}
      <div className={cn("grid gap-4", effective === "split" && "lg:grid-cols-2")}>
        {effective !== "preview" && (
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            readOnly={readOnly}
            autoFocus={autoFocus}
            spellCheck={false}
            aria-label="File content"
            className="min-h-[60vh] w-full resize-y rounded-md border bg-background p-4 font-mono text-sm leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 read-only:bg-muted/40"
          />
        )}
        {effective !== "edit" && (
          <div className="min-h-[60vh] overflow-auto rounded-md border bg-card p-4" aria-label="Preview">
            <MarkdownPreview content={value} />
          </div>
        )}
      </div>
    </div>
  );
}
