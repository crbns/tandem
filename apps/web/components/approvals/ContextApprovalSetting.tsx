"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { normalizeError, useTandemApi, type ContextApproval } from "@/lib/api";
import { ERROR_COPY } from "@/lib/api/errorCopy";
import { useResource } from "@/lib/api/useResource";
import { useWorkspaceRefresh } from "@/lib/api/useWorkspace";

const DESCRIPTIONS: Record<ContextApproval, string> = {
  manual: "Every context change, from people or assistants, waits here for an owner or admin.",
  automatic: "Context changes apply as soon as they're proposed. Nothing waits here.",
};

/**
 * Whether context proposals need approval. Owners and admins choose; members
 * see the current setting.
 */
export function ContextApprovalSetting({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const api = useTandemApi();
  const load = useCallback(() => api.getContextApproval(workspaceId), [api, workspaceId]);
  const { resource, reload } = useResource(load);
  useWorkspaceRefresh(workspaceId, reload);
  const [saving, setSaving] = useState(false);

  if (resource.status !== "ready") return null;
  const mode = resource.data;

  async function change(next: ContextApproval) {
    setSaving(true);
    try {
      await api.setContextApproval(workspaceId, next);
      toast.success(next === "automatic" ? "Context changes now apply automatically." : "Context changes now need approval.");
    } catch (err) {
      toast.error(ERROR_COPY[normalizeError(err).code].description);
    } finally {
      setSaving(false);
      reload();
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-card px-4 py-3 text-sm">
      <label htmlFor="context-approval" className="font-medium">
        Context changes
      </label>
      <select
        id="context-approval"
        className="h-8 rounded-md border border-input bg-card px-2 text-sm disabled:opacity-70"
        value={mode}
        onChange={(event) => void change(event.target.value as ContextApproval)}
        disabled={!canEdit || saving}
        title={canEdit ? undefined : "Owners and admins choose this"}
      >
        <option value="manual">Manual approval</option>
        <option value="automatic">Automatic</option>
      </select>
      <p className="basis-full text-muted-foreground">{DESCRIPTIONS[mode]}</p>
    </div>
  );
}
