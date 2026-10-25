"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { normalizeError, TandemApiError, useTandemApi } from "@/lib/api";
import { useSession } from "@/lib/auth/useSession";
import { ErrorState } from "@/components/common/ErrorState";
import { FullPageSpinner } from "@/components/common/FullPageSpinner";
import { normalizeInviteCode } from "@/lib/inviteCode";

export default function InvitePage() {
  const { token: param } = useParams<{ token: string }>();
  // Links and hand-typed URLs may say "abc-def" or "ABC%20DEF"; the backend wants "ABCDEF".
  const token = normalizeInviteCode(safeDecode(param));
  const { status } = useSession();
  const api = useTandemApi();
  const router = useRouter();
  const [error, setError] = useState<TandemApiError | null>(null);
  // Share the same mutation promise across Strict Mode's effect replay.
  const pending = useRef<{ token: string; result: Promise<{ workspaceId: string }> } | null>(null);

  useEffect(() => {
    if (!token) return;
    if (status === "unauthenticated") {
      router.replace(`/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`);
      return;
    }
    if (status !== "authenticated") return;
    let cancelled = false;
    if (pending.current?.token !== token) {
      pending.current = { token, result: api.acceptInvite(token) };
    }
    pending.current.result.then(
      ({ workspaceId }) => { if (!cancelled) router.replace(`/w/${workspaceId}/overview`); },
      (err: unknown) => { if (!cancelled) setError(normalizeError(err)); },
    );
    return () => { cancelled = true; };
  }, [status, token, api, router]);

  // A link with no letters left can't match any invite.
  const shown = error ?? (token ? null : new TandemApiError("INVITE_INVALID"));
  if (!shown) return <FullPageSpinner />;
  return <main className="mx-auto max-w-lg px-4 py-12"><ErrorState error={shown} /></main>;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
