"use client";

import { useEffect, useState } from "react";
import { useTandemApi, normalizeError, type FileDetail } from "@/lib/api";
import { ERROR_COPY } from "@/lib/api/errorCopy";
import { Button } from "@/components/ui/button";
import { UploadButton } from "./UploadButton";

export function BinaryPreview({ file, version = file.version, onUploaded }: { file: FileDetail; version?: number; onUploaded?: () => void }) {
  const api = useTandemApi();
  const [preview, setPreview] = useState<{ key: string; url?: string; mimeType?: string; error?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = `${file.id}:${version}`;
  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    api.getFileBlob(file.id, version).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setPreview({ key, url: objectUrl, mimeType: blob.type });
    }).catch((err: unknown) => {
      if (active) setPreview({ key, error: ERROR_COPY[normalizeError(err).code].description });
    });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [api, file.id, version, key, attempt]);
  const current = preview?.key === key ? preview : null;
  const url = current?.url;
  const mimeType = current?.mimeType || file.mimeType;
  return (
    <div className="flex flex-col gap-4 rounded-md border bg-card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-muted-foreground">{mimeType} · Version {version}</span>
        {url && <Button variant="outline" size="sm" asChild><a href={url} download={file.name}>Download</a></Button>}
        {file.permissions.canEdit && version === file.version && onUploaded && <UploadButton workspaceId={file.workspaceId} fileId={file.id} expectedVersion={file.version} onUploaded={onUploaded} />}
      </div>
      {current?.error ? <div role="alert"><p>{current.error}</p><Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>Retry</Button></div> : !url ? <p role="status">Loading file…</p> : mimeType.startsWith("image/") ? (
        // Authenticated blob URLs cannot use the Next image optimizer.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={file.name} className="max-h-[65vh] w-full object-contain" />
      ) : mimeType === "application/pdf" ? <iframe src={url} title={file.name} className="h-[65vh] w-full rounded border" /> : <p className="py-10 text-center text-muted-foreground">Preview unavailable for this file type. Download it to open it.</p>}
    </div>
  );
}
