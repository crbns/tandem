"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { INVITE_CODE_LENGTH, isCompleteInviteCode, normalizeInviteCode } from "@/lib/inviteCode";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Six-letter invite code entry. Opens /invite/<CODE>, which signs in if needed and joins. */
export function JoinWithCodeForm({ className }: { className?: string }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const code = normalizeInviteCode(value);
  const complete = isCompleteInviteCode(code);

  function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (complete) router.push(`/invite/${code}`);
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
            if (normalizeInviteCode(next).length <= INVITE_CODE_LENGTH) setValue(next.toUpperCase());
          }}
          placeholder="ABCDEF"
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          aria-describedby="invite-code-hint"
          className="font-mono uppercase tracking-[0.2em]"
        />
        <Button type="submit" variant="outline" disabled={!complete}>
          Join
        </Button>
      </div>
      <p id="invite-code-hint" className="text-xs text-muted-foreground">
        Enter the six letters from a teammate&apos;s invite.
      </p>
    </form>
  );
}
