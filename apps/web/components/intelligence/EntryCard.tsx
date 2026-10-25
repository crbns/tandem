"use client";

import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import { ArrowRightIcon, CheckIcon, HistoryIcon, Loader2Icon, PencilIcon, Undo2Icon } from "lucide-react";
import { toast } from "sonner";
import { normalizeError, useTandemApi, type TandemApiError } from "@/lib/api";
import { ERROR_COPY } from "@/lib/api/errorCopy";
import type { ObservedEntry, ObservedStatus } from "@/lib/api/types";
import { formatAbsolute, formatRelative } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { Confidence, EvidenceChip, SeverityChip } from "./chips";

/** Copy for corrections, where VERSION_CONFLICT means the context manager (or a teammate) got there first. */
export const CORRECTION_ERROR_COPY: Partial<Record<TandemApiError["code"], { title: string; description: string }>> = {
  VERSION_CONFLICT: {
    title: "This entry changed while you were editing",
    description: "The context manager or a teammate updated it first, so nothing was saved. Review the refreshed entry and correct it again.",
  },
  INVALID_INPUT: {
    title: "Check the correction",
    description: "Add a short note saying why, and keep the title and description non-empty.",
  },
};

function correctionError(error: TandemApiError) {
  return CORRECTION_ERROR_COPY[error.code] ?? ERROR_COPY[error.code];
}

const STATUS_OPTIONS: ReadonlyArray<{ value: ObservedStatus; label: string }> = [
  { value: "active", label: "Active / in progress" },
  { value: "completed", label: "Completed" },
  { value: "resolved", label: "Resolved" },
  { value: "superseded", label: "Superseded" },
  { value: "retracted", label: "Retracted (wrong)" },
];

type Mode = "view" | "edit" | "retract";

/**
 * One observed entry: what it says, how well it's supported, who it's about,
 * and a person's ways to fix it (confirm, edit, retract). Observed, not
 * project context.
 */
export function EntryCard({
  entry,
  workspaceId,
  onOpenHistory,
}: {
  entry: ObservedEntry;
  workspaceId: string;
  onOpenHistory: (entryId: string) => void;
}) {
  const api = useTandemApi();
  const now = useNow();
  const formId = useId();
  const [mode, setMode] = useState<Mode>("view");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TandemApiError | null>(null);
  const [draft, setDraft] = useState({ title: entry.title, content: entry.content, status: entry.status, note: "" });

  const begin = (next: Mode) => {
    setDraft({ title: entry.title, content: entry.content, status: entry.status, note: "" });
    setError(null);
    setMode(next);
  };

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      toast.success(success);
      setMode("view");
    } catch (err) {
      const normalized = normalizeError(err);
      setError(normalized);
      if (mode === "view") toast.error(correctionError(normalized).title);
    } finally {
      setBusy(false);
    }
  };

  const confirm = () =>
    run(
      () => api.correctEntry(workspaceId, entry.id, { expectedRevision: entry.revision, status: entry.status, note: "Confirmed as accurate" }),
      "Confirmed. Assistants see it as confirmed by a person on their next sync.",
    );

  const submitEdit = (event: FormEvent) => {
    event.preventDefault();
    void run(
      () =>
        api.correctEntry(workspaceId, entry.id, {
          expectedRevision: entry.revision,
          ...(draft.title.trim() !== entry.title ? { title: draft.title } : {}),
          ...(draft.content.trim() !== entry.content ? { content: draft.content } : {}),
          status: draft.status,
          note: draft.note,
        }),
      "Correction saved.",
    );
  };

  const submitRetract = (event: FormEvent) => {
    event.preventDefault();
    void run(
      () => api.retractEntry(workspaceId, entry.id, { expectedRevision: entry.revision, ...(draft.note.trim() ? { note: draft.note } : {}) }),
      "Retracted. It moves to history and leaves the observed state.",
    );
  };

  const confirmed = entry.evidence === "human_confirmed";
  return (
    <article
      aria-labelledby={`${formId}-title`}
      className={cn(
        "flex flex-col gap-1.5 rounded-sm border bg-card px-3 py-2.5",
        entry.severity === "actual" && "border-destructive/40 shadow-[inset_3px_0_0_var(--destructive)]",
        entry.severity === "potential" && "border-dashed border-warn-rule",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <EvidenceChip evidence={entry.evidence} />
        <SeverityChip severity={entry.severity} />
        {entry.status !== "active" && <span className="label-caps text-muted-foreground">{entry.status}</span>}
        <Confidence value={entry.confidence} />
        <time
          dateTime={new Date(entry.updatedAt).toISOString()}
          title={formatAbsolute(entry.updatedAt)}
          className="ml-auto text-[0.6875rem] text-muted-foreground"
        >
          {formatRelative(entry.updatedAt, now)}
        </time>
      </div>
      <h4 id={`${formId}-title`} className="text-sm font-medium leading-5">
        {entry.title}
      </h4>
      {entry.content && entry.content !== entry.title && <p className="line-clamp-3 text-xs text-muted-foreground">{entry.content}</p>}

      {(entry.agents.length > 0 || entry.files.length > 0 || entry.contextEntryId) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem] text-muted-foreground">
          {entry.agents.length > 0 && (
            <span className="inline-flex min-w-0 items-center gap-1">
              <span aria-hidden className="inline-block size-2 shrink-0 bg-agent" />
              <span className="truncate">{entry.agents.map((a) => a.label).join(", ")}</span>
            </span>
          )}
          {entry.files.map((file) =>
            file.deleted ? (
              <span key={file.id} className="line-through">{file.name}</span>
            ) : (
              <Link key={file.id} href={`/w/${workspaceId}/files/${file.id}`} className="font-medium text-primary hover:underline">
                {file.name}
              </Link>
            ),
          )}
          {entry.contextEntryId && (
            <Link href={`/w/${workspaceId}/context`} className="inline-flex items-center gap-1 font-medium text-human hover:underline">
              In project context
              <ArrowRightIcon aria-hidden className="size-3" />
            </Link>
          )}
        </div>
      )}

      {mode === "view" && (
        <div className="-mx-1 flex flex-wrap items-center gap-0.5" role="group" aria-label={`Actions for ${entry.title}`}>
          <IconAction icon={HistoryIcon} label="History and evidence" onClick={() => onOpenHistory(entry.id)} />
          {!confirmed && <IconAction icon={CheckIcon} label="Confirm" onClick={() => void confirm()} disabled={busy} />}
          <IconAction icon={PencilIcon} label="Correct" onClick={() => begin("edit")} disabled={busy} />
          <IconAction icon={Undo2Icon} label="Retract" onClick={() => begin("retract")} disabled={busy} />
          {busy && <Loader2Icon aria-label="Saving" className="ml-1 size-3.5 animate-spin text-muted-foreground" />}
        </div>
      )}

      {mode === "edit" && (
        <form onSubmit={submitEdit} className="mt-1 flex flex-col gap-2 border-t pt-2" aria-label={`Correct ${entry.title}`}>
          <Label htmlFor={`${formId}-t`} className="text-xs">Title</Label>
          <Input id={`${formId}-t`} value={draft.title} maxLength={200} required disabled={busy} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          <Label htmlFor={`${formId}-c`} className="text-xs">Description</Label>
          <textarea
            id={`${formId}-c`}
            className="flex min-h-16 w-full min-w-0 resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            rows={3}
            maxLength={4000}
            required
            disabled={busy}
            value={draft.content}
            onChange={(e) => setDraft({ ...draft, content: e.target.value })}
          />
          <Label htmlFor={`${formId}-s`} className="text-xs">Status</Label>
          <select
            id={`${formId}-s`}
            className="h-9 rounded-md border border-input bg-card px-2 text-sm"
            value={draft.status}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, status: e.target.value as ObservedStatus })}
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <NoteField id={`${formId}-n`} value={draft.note} disabled={busy} required onChange={(note) => setDraft({ ...draft, note })} />
          <p className="text-[0.6875rem] text-muted-foreground">Saving marks the entry as confirmed by you. It stays observed context, not project context.</p>
          <FormFooter busy={busy} error={error} submit="Save correction" onCancel={() => setMode("view")} />
        </form>
      )}

      {mode === "retract" && (
        <form onSubmit={submitRetract} className="mt-1 flex flex-col gap-2 border-t pt-2" aria-label={`Retract ${entry.title}`}>
          <NoteField id={`${formId}-r`} value={draft.note} disabled={busy} onChange={(note) => setDraft({ ...draft, note })} />
          <FormFooter busy={busy} error={error} submit="Retract entry" destructive onCancel={() => setMode("view")} />
        </form>
      )}
    </article>
  );
}

function IconAction({ icon: Icon, label, onClick, disabled }: { icon: typeof CheckIcon; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      className="size-7 text-muted-foreground hover:text-foreground [&_svg]:size-3.5"
      onClick={onClick}
      disabled={disabled}
    >
      <Icon aria-hidden />
    </Button>
  );
}

function NoteField({ id, value, onChange, disabled, required }: { id: string; value: string; onChange: (value: string) => void; disabled: boolean; required?: boolean }) {
  return (
    <>
      <Label htmlFor={id} className="text-xs">
        Why {required ? "" : <span className="font-normal text-muted-foreground">(optional)</span>}
      </Label>
      <Input id={id} value={value} maxLength={500} required={required} disabled={disabled} placeholder="e.g. e2e tests are still failing" onChange={(e) => onChange(e.target.value)} autoFocus />
    </>
  );
}

function FormFooter({ busy, error, submit, destructive, onCancel }: { busy: boolean; error: TandemApiError | null; submit: string; destructive?: boolean; onCancel: () => void }) {
  return (
    <div className="flex flex-col gap-2">
      {error && (
        <div role="alert" className="rounded-sm border border-destructive/30 bg-destructive/[0.04] px-2.5 py-2 text-xs">
          <p className="font-medium text-destructive">{correctionError(error).title}</p>
          <p className="text-muted-foreground">{correctionError(error).description}</p>
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" variant={destructive ? "destructive" : "default"} size="sm" disabled={busy}>
          {busy && <Loader2Icon className="animate-spin" />}
          {submit}
        </Button>
      </div>
    </div>
  );
}
