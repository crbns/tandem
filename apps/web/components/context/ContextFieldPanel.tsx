"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { normalizeError, useTandemApi } from "@/lib/api";
import type {
  ContextEntry,
  ContextField,
  FileSummary,
  WorkspaceMember,
} from "@/lib/api/types";
import { FIELD_LABELS, replacesValue } from "@/lib/proposals";
import { ERROR_COPY } from "@/lib/api/errorCopy";
import { formatAbsolute } from "@/lib/time";
import { displayId } from "@/lib/files";
import { ActorBadge } from "@/components/common/ActorBadge";
import { fileHref } from "@/components/files/FileTable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SourceLinks({
  workspaceId,
  ids,
  files,
}: {
  workspaceId: string;
  ids: string[];
  files: FileSummary[];
}) {
  return ids.length ? (
    <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
      <span className="text-muted-foreground">Sources</span>
      {ids.map((id) => (
        <Link
          key={id}
          href={fileHref(workspaceId, id)}
          className="underline underline-offset-2 hover:text-archive"
        >
          {files.find((file) => file.id === id)?.name ?? displayId(id)}
        </Link>
      ))}
    </span>
  ) : (
    <span className="text-xs text-muted-foreground">
      No source files linked
    </span>
  );
}

interface Props {
  workspaceId: string;
  field: ContextField;
  label: string;
  entries: ContextEntry[];
  version: number;
  canEdit: boolean;
  canPropose: boolean;
  files: FileSummary[];
  members: WorkspaceMember[];
  onSaved: () => void;
}

interface Draft {
  text: string;
  sourceFileIds: string[];
  ownerUserId: string;
  rationale: string;
  expectedVersion: number;
  entryId?: string;
  supersedes?: string;
}

export function ContextFieldPanel({
  workspaceId,
  field,
  label,
  entries,
  version,
  canEdit,
  canPropose,
  files,
  members,
  onSaved,
}: Props) {
  const api = useTandemApi();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = (entry?: ContextEntry, supersedes?: string) => {
    setError(null);
    setDraft({
      text: supersedes ? "" :
        field === "ownership" ? (entry?.ownerArea ?? "") : (entry?.text ?? ""),
      sourceFileIds: [...(entry?.sourceFileIds ?? [])],
      ownerUserId: entry?.ownerUserId ?? "",
      rationale: "",
      expectedVersion: version,
      ...(entry && !supersedes && !replacesValue(field) ? { entryId: entry.id } : {}),
      ...(supersedes ? { supersedes } : {}),
    });
  };
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setBusy(true);
    setError(null);
    const input = {
      field,
      proposedValue: draft.text,
      sourceFileIds: draft.sourceFileIds,
      ...(field === "ownership" ? { ownerUserId: draft.ownerUserId } : {}),
    };
    try {
      let message = `${FIELD_LABELS[field]} saved.`;
      if (canEdit && !draft.supersedes)
        await api.updateContextField(workspaceId, {
          ...input,
          expectedVersion: draft.expectedVersion,
          ...(draft.entryId ? { entryId: draft.entryId } : {}),
        });
      else {
        const result = await api.proposeContextChange(workspaceId, {
          ...input,
          rationale: draft.rationale,
          expectedVersion: draft.expectedVersion,
          ...(draft.supersedes ? { supersedes: draft.supersedes } : {}),
        });
        message = result.status === "applied" ? `${FIELD_LABELS[field]} recorded.` : "Proposal sent to Approvals.";
      }
      toast.success(message);
      setDraft(null);
      onSaved();
    } catch (err) {
      const failure = normalizeError(err);
      setError(
        failure.code === "VERSION_CONFLICT"
          ? "Context changed while you were editing. Cancel and reopen the editor to review the latest version before saving."
          : ERROR_COPY[failure.code].description,
      );
      onSaved();
    } finally {
      setBusy(false);
    }
  }
  async function changeStatus(entry: ContextEntry, operation: "resolve" | "remove") {
    setBusy(true);
    setError(null);
    try {
      await api.proposeContextChange(workspaceId, {
        field, operation, entryId: entry.id, expectedVersion: version,
        proposedValue: entry.text, sourceFileIds: entry.sourceFileIds,
        rationale: operation === "resolve" ? "Resolved from project context." : "Removed from project context.",
      });
      toast.success(operation === "resolve" ? "Question resolved." : `${FIELD_LABELS[field]} removed.`);
      setDraft(null);
    } catch (err) {
      const failure = normalizeError(err);
      setError(failure.code === "VERSION_CONFLICT"
        ? "Context changed. Review the refreshed entries before trying again."
        : ERROR_COPY[failure.code].description);
    } finally {
      setBusy(false);
      onSaved();
    }
  }
  return (
    <section
      aria-labelledby={`context-${field}`}
      className="rounded-md border bg-card px-5 py-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id={`context-${field}`} className="text-base font-bold">
          {label}
        </h2>
        {(canEdit || canPropose) && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => open(replacesValue(field) ? entries[0] : undefined)}
          >
            {canEdit
              ? replacesValue(field)
                ? "Edit"
                : "Add"
              : field === "constraint" || field === "open_question" ? "Add" : "Propose change"}
          </Button>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Nothing recorded yet.
        </p>
      ) : (
        <ul className="divide-y">
          {entries.map((entry, index) => (
            <li key={entry.id} className="flex flex-col gap-2 py-3 last:pb-0">
              <div className="flex items-start justify-between gap-3">
                <p className="whitespace-pre-wrap break-words text-sm">
                  {entry.text}
                </p>
                <div className="flex shrink-0 gap-1">
                  {canEdit && entry.status === "active" && !replacesValue(field) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`Edit ${FIELD_LABELS[field]} ${index + 1}`}
                      onClick={() => open(entry)}
                    >
                      Edit
                    </Button>
                  )}
                  {(canEdit || canPropose) && entry.status === "active" && field === "decision" && (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => open(entry, entry.id)} aria-label={`Supersede decision ${index + 1}`}>Supersede</Button>
                  )}
                  {(canEdit || canPropose) && entry.status === "active" && field === "open_question" && (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void changeStatus(entry, "resolve")} aria-label={`Resolve open question ${index + 1}`}>Resolve</Button>
                  )}
                  {(canEdit || canPropose) && (field === "constraint" || field === "open_question") && (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void changeStatus(entry, "remove")} aria-label={`Remove ${FIELD_LABELS[field]} ${index + 1}`}>Remove</Button>
                  )}
                </div>
              </div>
              {entry.status === "resolved" && (
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>Resolved</span>
                  {entry.resolvedBy && <ActorBadge actor={entry.resolvedBy} />}
                  {entry.resolvedAt !== null && <time dateTime={new Date(entry.resolvedAt).toISOString()}>{formatAbsolute(entry.resolvedAt)}</time>}
                </p>
              )}
              {entry.status === "superseded" && (
                <p className="text-xs text-muted-foreground">Superseded{entry.supersededBy ? ` by ${displayId(entry.supersededBy)}` : ""}</p>
              )}
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span>Set by</span>
                <ActorBadge actor={entry.updatedBy} />
                <time dateTime={new Date(entry.updatedAt).toISOString()}>
                  {formatAbsolute(entry.updatedAt)}
                </time>
              </p>
              <SourceLinks
                workspaceId={workspaceId}
                ids={entry.sourceFileIds}
                files={files}
              />
            </li>
          ))}
        </ul>
      )}
      {error && !draft && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
      {draft && (
        <form
          onSubmit={(event) => void save(event)}
          className="mt-4 flex flex-col gap-3 border-t pt-4"
        >
          {draft.supersedes && <p className="text-xs text-muted-foreground">Propose a replacement decision. The existing decision stays active until approval.</p>}
          <Label htmlFor={`value-${field}`}>
            {field === "ownership"
              ? "Area of responsibility"
              : FIELD_LABELS[field]}
          </Label>
          {field === "ownership" ? (
            <Input
              id={`value-${field}`}
              value={draft.text}
              onChange={(event) =>
                setDraft({ ...draft, text: event.target.value })
              }
              required
              maxLength={200}
              disabled={busy}
              autoFocus
            />
          ) : (
            <textarea
              id={`value-${field}`}
              className="flex min-h-24 w-full min-w-0 resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive"
              value={draft.text}
              onChange={(event) =>
                setDraft({ ...draft, text: event.target.value })
              }
              rows={3}
              required
              maxLength={10000}
              disabled={busy}
              autoFocus
            />
          )}
          {field === "ownership" && (
            <>
              <Label htmlFor="context-owner">Owner</Label>
              <select
                id="context-owner"
                className="h-9 rounded-md border border-input bg-card px-3 text-sm"
                value={draft.ownerUserId}
                onChange={(event) =>
                  setDraft({ ...draft, ownerUserId: event.target.value })
                }
                required
                disabled={busy}
              >
                <option value="">Choose a member</option>
                {members.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.name}
                  </option>
                ))}
              </select>
            </>
          )}
          {(!canEdit || draft.supersedes) && (
            <>
              <Label htmlFor={`reason-${field}`}>Reason for change</Label>
              <Input
                id={`reason-${field}`}
                value={draft.rationale}
                onChange={(event) =>
                  setDraft({ ...draft, rationale: event.target.value })
                }
                required
                disabled={busy}
              />
            </>
          )}
          {files.length > 0 && (
            <fieldset
              disabled={busy}
              className="flex max-h-40 flex-col gap-2 overflow-auto text-sm"
            >
              <legend className="mb-2 font-medium">
                Source files (optional)
              </legend>
              {files.map((file) => (
                <label key={file.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draft.sourceFileIds.includes(file.id)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        sourceFileIds: event.target.checked
                          ? [...draft.sourceFileIds, file.id]
                          : draft.sourceFileIds.filter((id) => id !== file.id),
                      })
                    }
                  />
                  {file.name}
                </label>
              ))}
            </fieldset>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button size="sm" disabled={busy}>
              {busy ? "Saving…" : draft.supersedes ? "Send proposal" : canEdit ? "Save" : field === "constraint" || field === "open_question" ? "Record" : "Send proposal"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setDraft(null)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
