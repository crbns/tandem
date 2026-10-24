"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { UploadIcon } from "lucide-react";
import { normalizeError, useTandemApi } from "@/lib/api";
import { describeError } from "@/lib/api/errorCopy";
import { Button } from "@/components/ui/button";

export function UploadButton({ workspaceId, fileId, expectedVersion, parentId = null, onUploaded }: {
  /** `parentId` places a new upload in a folder; ignored for a new version. */
  workspaceId: string; fileId?: string; expectedVersion?: number; parentId?: string | null; onUploaded?: () => void;
}) {
  const api = useTandemApi();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <input ref={input} type="file" className="sr-only" tabIndex={-1} aria-label={fileId ? "Select a new version" : "Select a file to upload"} disabled={busy} onChange={async (event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (!file) return;
        setMessage(null);
        if (file.size < 1 || file.size > 25 * 1024 * 1024) {
          setError("Choose a non-empty file up to 25 MB.");
          return;
        }
        setBusy(true);
        setError(null);
        try {
          const result = await api.uploadFile(workspaceId, file, fileId && expectedVersion !== undefined ? { fileId, expectedVersion } : parentId ? { parentId } : undefined);
          if (result.pending) {
            setMessage("Upload is taking longer than expected; it will appear in the file list when it finishes.");
            return;
          }
          if (fileId) onUploaded?.();
          else router.push(`/w/${workspaceId}/files/${result.id}`);
        } catch (err) {
          const normalized = normalizeError(err);
          setError(normalized.code === "VERSION_CONFLICT" ? "A newer version was saved. Refresh the file and review it before uploading again." : describeError(normalized));
        } finally { setBusy(false); }
      }} />
      <Button variant="outline" size="sm" disabled={busy} onClick={() => input.current?.click()}>
        <UploadIcon />{busy ? "Uploading…" : fileId ? "Upload new version" : "Upload file"}
      </Button>
      {error && <p role="alert" className="max-w-sm text-sm text-destructive">{error}</p>}
      {message && <p role="status" className="max-w-sm text-sm text-muted-foreground">{message}</p>}
    </div>
  );
}
