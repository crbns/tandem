"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon } from "lucide-react";
import { normalizeError, useTandemApi } from "@/lib/api";
import { ERROR_COPY } from "@/lib/api/errorCopy";
import { useSession } from "@/lib/auth/useSession";
import { INVITE_CODE_LENGTH, isCompleteInviteCode, normalizeInviteCode } from "@/lib/inviteCode";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Six-letter invite code entry. Joins in place; signed-out visitors sign in
 * first and come back to /invite/<CODE> with the code filled in.
 */
export function JoinWithCodeForm({ initialCode = "", className }: { initialCode?: string; className?: string }) {
  const { status } = useSession();
  const api = useTandemApi();
  const router = useRouter();
  const [value, setValue] = useState(() => normalizeInviteCode(initialCode).slice(0, INVITE_CODE_LENGTH));
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const code = normalizeInviteCode(value);
  const complete = isCompleteInviteCode(code);

  async function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!complete || status === "loading") return;
    if (status === "unauthenticated") {
      router.push(`/sign-in?next=${encodeURIComponent(`/invite/${code}`)}`);
      return;
    }
    setJoining(true);
    setError(null);
    try {
      const { workspaceId } = await api.acceptInvite(code);
      router.replace(`/w/${workspaceId}/overview`);
    } catch (err) {
      setError(ERROR_COPY[normalizeError(err).code].description);
      setJoining(false);
    }
  }

  return (
    <form onSubmit={join} className={cn("grid gap-2", className)}>
      <Label htmlFor="invite-code">Join with a code</Label>
      <div className="flex gap-2">
        <Input
          id="invite-code"
          value={value}
          // Keep a dash or space someone types ("ABC-DEF"), but cap the letters at six.
          // A pasted invite link keeps only the code after /invite/.
          onChange={(event) => {
            const next = event.target.value.split("/invite/").pop() ?? "";
            if (normalizeInviteCode(next).length <= INVITE_CODE_LENGTH) {
              setValue(next.toUpperCase());
              setError(null);
            }
          }}
          placeholder="ABCDEF"
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          aria-describedby="invite-code-hint"
          aria-invalid={error ? true : undefined}
          className="font-mono uppercase tracking-[0.2em]"
        />
        <Button type="submit" variant="outline" disabled={!complete || joining || status === "loading"}>
          {joining && <Loader2Icon className="animate-spin" />}
          Join
        </Button>
      </div>
      {error ? (
        <p id="invite-code-hint" role="alert" className="text-xs text-destructive">{error}</p>
      ) : (
        <p id="invite-code-hint" className="text-xs text-muted-foreground">
          Enter the six letters from a teammate&apos;s invite.
        </p>
      )}
    </form>
  );
}
