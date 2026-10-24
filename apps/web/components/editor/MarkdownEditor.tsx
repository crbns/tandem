"use client";

import { useState } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MarkdownPreview } from "@/components/editor/MarkdownPreview";
import { cn } from "@/lib/utils";

type View = "edit" | "preview" | "split";

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Plain text files get the textarea only. */
  markdown: boolean;
  readOnly?: boolean;
}

const isView = (v: string): v is View => v === "edit" || v === "preview" || v === "split";

export function MarkdownEditor({ value, onChange, markdown, readOnly }: MarkdownEditorProps) {
  const [view, setView] = useState<View>("split");
  const effective: View = markdown ? view : "edit";

  const textarea = (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      readOnly={readOnly}
      spellCheck={false}
      aria-label="File content"
      className="min-h-[60vh] w-full resize-y rounded-md border bg-background p-4 font-mono text-sm leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 read-only:bg-muted/40"
    />
  );

  return (
    <div className="flex flex-col gap-2">
      {markdown && (
        <Tabs value={view} onValueChange={(v) => isView(v) && setView(v)}>
          <TabsList>
            <TabsTrigger value="edit">Edit</TabsTrigger>
            <TabsTrigger value="preview">Preview</TabsTrigger>
            <TabsTrigger value="split">Split</TabsTrigger>
          </TabsList>
        </Tabs>
      )}
      <div className={cn("grid gap-4", effective === "split" && "lg:grid-cols-2")}>
        {effective !== "preview" && textarea}
        {effective !== "edit" && (
          <div className="min-h-[60vh] overflow-auto rounded-md border bg-card p-4">
            <MarkdownPreview content={value} />
          </div>
        )}
      </div>
    </div>
  );
}
