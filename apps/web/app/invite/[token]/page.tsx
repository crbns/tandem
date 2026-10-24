"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { normalizeError, useTandemApi, type TandemApiError } from "@/lib/api";
import { useSession } from "@/lib/auth/useSession";
import { ErrorState } from "@/components/common/ErrorState";
import { FullPageSpinner } from "@/components/common/FullPageSpinner";

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const { status } = useSession();
  const api = useTandemApi();
  const router = useRouter();
  const [error, setError] = useState<TandemApiError | null>(null);
  // Share the same mutation promise across Strict Mode's effect replay.
  const pending = useRef<{ token: string; result: Promise<{ workspaceId: string }> } | null>(null);

  useEffect(() => {
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
      ({ workspaceId }) => { if (!cancelled) router.replace(`/w/${workspaceId}`); },
      (err: unknown) => { if (!cancelled) setError(normalizeError(err)); },
    );
    return () => { cancelled = true; };
  }, [status, token, api, router]);

  if (!error) return <FullPageSpinner />;
  return <main className="mx-auto max-w-lg px-4 py-12"><ErrorState error={error} /></main>;
}
